import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../src/config.js";
import { UserPromptManager } from "../src/services/user-prompt/user-prompt-manager.js";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";
import { utf8ByteLength } from "../src/utils/context-limit.js";

const dir = mkdtempSync(join(tmpdir(), "pending-capture-evidence-"));
const dbPath = join(dir, "user-prompts.db");
const originalStorage = CONFIG.storagePath;
let mgr: UserPromptManager;
const db = () => tursoConnectionManager.getConnection(dbPath);

beforeAll(() => {
  CONFIG.storagePath = dir;
});
beforeEach(async () => {
  mgr = new UserPromptManager();
  await mgr.getPendingCaptureSessions("/project");
  const conn = await db();
  await conn.run("DELETE FROM pending_capture_evidence");
  await conn.run("DELETE FROM user_prompts");
});
afterAll(async () => {
  await tursoConnectionManager.closeConnection(dbPath);
  CONFIG.storagePath = originalStorage;
  rmSync(dir, { recursive: true, force: true });
});
const prompt = (session = "s", message = "m", project = "/project") =>
  mgr.savePrompt(session, message, project, "synthetic test prompt");
const count = async () =>
  Number((await (await db()).get("SELECT COUNT(*) n FROM pending_capture_evidence"))!.n);

describe("durable pending capture evidence", () => {
  it("requires a checkpoint and survives a closed connection and new manager", async () => {
    const id = await prompt();
    expect(await mgr.saveCaptureEvidence(id, "/project", "a", "completed assistant output")).toBe(
      true
    );
    expect(await mgr.getCaptureEvidence(id, "/project")).toBeNull();
    expect(await mgr.getPendingCaptureSessions("/project")).toEqual([]);
    await mgr.markCaptureEvidenceReady("s", "/project");
    await tursoConnectionManager.closeConnection(dbPath);
    mgr = new UserPromptManager();
    expect(await mgr.getCaptureEvidence(id, "/project")).toBe("completed assistant output");
    expect(await mgr.getPendingCaptureSessions("/project")).toEqual(["s"]);
  });

  it("replaces duplicates, preserves identical readiness, and resets changed readiness", async () => {
    const id = await prompt();
    await mgr.saveCaptureEvidence(id, "/project", "a", "one");
    await mgr.markCaptureEvidenceReady("s", "/project");
    await mgr.saveCaptureEvidence(id, "/project", "a", "one");
    expect(await mgr.getCaptureEvidence(id, "/project")).toBe("one");
    await mgr.saveCaptureEvidence(id, "/project", "a", "two");
    expect(await mgr.getCaptureEvidence(id, "/project")).toBeNull();
    expect(await count()).toBe(1);
    await mgr.markCaptureEvidenceReady("s", "/project");
    expect(await mgr.getCaptureEvidence(id, "/project")).toBe("two");
  });

  it("serializes concurrent duplicate upserts without exceeding limits", async () => {
    const id = await prompt();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        mgr.saveCaptureEvidence(id, "/project", "same", `version-${i}`)
      )
    );
    expect(await count()).toBe(1);
    await mgr.markCaptureEvidenceReady("s", "/project");
    expect(await mgr.getCaptureEvidence(id, "/project")).toMatch(/^version-/);
    await mgr.saveCaptureEvidence(id, "/other", "same", "<private>hidden</private>");
    expect(await count()).toBe(1);
    await mgr.saveCaptureEvidence(id, "/project", "same", "<private>hidden</private>");
    expect(await count()).toBe(0);
  });

  it("enforces project and authored message ownership, including claimed prompts", async () => {
    const id = await prompt();
    expect(await mgr.saveCaptureEvidence(id, "/other", "a", "wrong")).toBe(false);
    expect(await mgr.saveCaptureEvidence("missing", "/project", "a", "wrong")).toBe(false);
    expect(await mgr.getPendingPromptForMessage("s", "other", "/project")).toBeNull();
    expect(await mgr.getPendingPromptForMessage("s", "m", "/other")).toBeNull();
    expect(await mgr.hasPendingCaptureSession("s", "/other")).toBe(false);
    expect(await mgr.getPendingPromptForMessage("s", "m", "/project")).toMatchObject({ id });
    await mgr.claimPrompt(id);
    expect(await mgr.saveCaptureEvidence(id, "/project", "a", "right")).toBe(true);
    await mgr.markCaptureEvidenceReady("s", "/other");
    expect(await mgr.getCaptureEvidence(id, "/project")).toBeNull();
    await mgr.markCaptureEvidenceReady("s", "/project");
    expect(await mgr.getCaptureEvidence(id, "/other")).toBeNull();
    expect(await mgr.getPendingCaptureSessions("/project")).toEqual([]);
    await mgr.releaseClaim(id);
    expect(await mgr.getPendingCaptureSessions("/project")).toEqual(["s"]);
    for (let i = 0; i < (CONFIG.autoCaptureMaxRetries ?? 3); i++) await mgr.recordFailedAttempt(id);
    expect(await mgr.getPendingCaptureSessions("/project")).toEqual([]);
  });

  it("prunes expired evidence at initialization without deleting authored history", async () => {
    const id = await prompt();
    await mgr.saveCaptureEvidence(id, "/project", "a", "old evidence");
    await mgr.markCaptureEvidenceReady("s", "/project");
    await (
      await db()
    ).run("UPDATE pending_capture_evidence SET updated_at = ?", [Date.now() - 86400001]);
    mgr = new UserPromptManager();
    expect(await mgr.getPendingCaptureSessions("/project")).toEqual([]);
    expect(await count()).toBe(0);
    expect(await mgr.getPromptById(id)).not.toBeNull();
  });

  it("sanitizes before byte truncation and enforces part and result limits", async () => {
    const id = await prompt();
    expect(await mgr.saveCaptureEvidence(id, "/project", "x".repeat(257), "no")).toBe(false);
    expect(
      await mgr.saveCaptureEvidence(id, "/project", "private", "<private>secret</private>")
    ).toBe(false);
    await mgr.saveCaptureEvidence(
      id,
      "/project",
      "privacy",
      "visible<private>" + "secret".repeat(5000)
    );
    await mgr.markCaptureEvidenceReady("s", "/project");
    expect(await mgr.getCaptureEvidence(id, "/project")).toBe("visible[REDACTED]");
    for (let i = 0; i < 20; i++)
      await mgr.saveCaptureEvidence(id, "/project", `part-${i}`, "😀".repeat(20000));
    expect(await count()).toBe(16);
    const rows = await (await db()).all("SELECT content FROM pending_capture_evidence");
    for (const row of rows) {
      expect(utf8ByteLength(String(row.content))).toBeLessThanOrEqual(16384);
      expect(String(row.content)).not.toContain("�");
    }
    await mgr.markCaptureEvidenceReady("s", "/project");
    expect(utf8ByteLength((await mgr.getCaptureEvidence(id, "/project"))!)).toBeLessThanOrEqual(
      65536
    );
  });

  it("bounds all retained parts globally", async () => {
    for (let i = 0; i < 18; i++) {
      const id = await prompt(`s${i}`);
      for (let j = 0; j < 16; j++)
        await mgr.saveCaptureEvidence(id, "/project", `${j}`, "small synthetic evidence");
    }
    expect(await count()).toBe(256);
  });

  it("cleans evidence on capture, bulk capture, delete, and age cleanup", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = await prompt(`s${i}`);
      ids.push(id);
      await mgr.saveCaptureEvidence(id, "/project", "a", "evidence");
    }
    await mgr.markAsCaptured(ids[0]!);
    expect(await mgr.saveCaptureEvidence(ids[0]!, "/project", "a", "late event")).toBe(false);
    await mgr.markMultipleAsCaptured([ids[1]!]);
    await mgr.deletePrompt(ids[2]!);
    expect(await count()).toBe(1);
    await (await db()).run("UPDATE user_prompts SET created_at = 1 WHERE id = ?", [ids[3]!]);
    expect((await mgr.deleteOldPrompts(2)).deleted).toBe(1);
    expect(await count()).toBe(0);
    expect(await mgr.getPromptById(ids[0]!)).not.toBeNull();
  });
});
