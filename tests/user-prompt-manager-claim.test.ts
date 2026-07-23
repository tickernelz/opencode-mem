import { afterAll, beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TursoDb } from "../src/services/turso/turso-db.js";

const sandbox = mkdtempSync(join(tmpdir(), "opencode-mem-claim-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const { UserPromptManager } = await import("../src/services/user-prompt/user-prompt-manager.js");

type TestableManager = InstanceType<typeof UserPromptManager> & {
  ready(): Promise<TursoDb>;
};

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("UserPromptManager.claimPrompt / releaseClaim", () => {
  let mgr: TestableManager;
  let activeIds: string[];

  beforeEach(() => {
    mgr = new UserPromptManager() as TestableManager;
    activeIds = [];
  });

  afterEach(async () => {
    for (const id of activeIds) {
      try {
        await mgr.deletePrompt(id);
      } catch {
        // ignore
      }
    }
  });

  async function getRawCaptured(id: string): Promise<number> {
    const db = await mgr.ready();
    const row = await db.get(`SELECT captured FROM user_prompts WHERE id = ?`, [id]);
    return row ? Number(row.captured) : -1;
  }

  async function setCreatedAt(id: string, createdAt: number): Promise<void> {
    const db = await mgr.ready();
    await db.run(`UPDATE user_prompts SET created_at = ? WHERE id = ?`, [createdAt, id]);
  }

  async function newPrompt(sessionId = "session-test", content = "hello") {
    const id = await mgr.savePrompt(
      sessionId,
      `msg-${Date.now()}-${Math.random()}`,
      "/tmp/proj",
      content
    );
    activeIds.push(id);
    return id;
  }

  it("claimPrompt transitions captured 0 → 2 and returns true", async () => {
    const id = await newPrompt();
    expect(await mgr.claimPrompt(id)).toBe(true);
    expect(await getRawCaptured(id)).toBe(2);
  });

  it("claimPrompt returns false when the row is already claimed", async () => {
    const id = await newPrompt();
    expect(await mgr.claimPrompt(id)).toBe(true);
    expect(await mgr.claimPrompt(id)).toBe(false);
  });

  it("releaseClaim transitions captured 2 → 0 and exposes the row to retry", async () => {
    const id = await newPrompt("session-release");
    expect(await mgr.claimPrompt(id)).toBe(true);
    expect(await mgr.releaseClaim(id)).toBe(true);
    expect(await getRawCaptured(id)).toBe(0);

    const next = await mgr.getLastUncapturedPrompt("session-release");
    expect(next).not.toBeNull();
    expect(next!.id).toBe(id);
  });

  it("releaseClaim is a no-op when the row is already captured=1", async () => {
    const id = await newPrompt();
    await mgr.claimPrompt(id);
    await mgr.markAsCaptured(id);

    expect(await mgr.releaseClaim(id)).toBe(false);
    expect(await getRawCaptured(id)).toBe(1);
  });

  it("releaseClaim is a no-op when the row was never claimed", async () => {
    const id = await newPrompt();
    expect(await mgr.releaseClaim(id)).toBe(false);
    expect(await getRawCaptured(id)).toBe(0);
  });

  it("supports a full claim → release → re-claim retry cycle", async () => {
    const id = await newPrompt();
    expect(await mgr.claimPrompt(id)).toBe(true);
    expect(await mgr.releaseClaim(id)).toBe(true);
    expect(await mgr.claimPrompt(id)).toBe(true);
    expect(await getRawCaptured(id)).toBe(2);
  });

  it("ignores prompts that have exceeded max retries", async () => {
    const id = await mgr.savePrompt("session-retries", "msg-1", "/path", "hello retry");
    activeIds.push(id);

    for (let i = 0; i < 4; i++) {
      await mgr.recordFailedAttempt(id);
    }

    const prompt = await mgr.getLastUncapturedPrompt("session-retries");
    expect(prompt).toBeNull();
  });

  it("returns all uncaptured prompts for a session oldest first", async () => {
    const later = await newPrompt("session-batch", "later");
    const older = await newPrompt("session-batch", "older");
    const captured = await newPrompt("session-batch", "captured");
    const otherSession = await newPrompt("session-other", "other");
    const retriedOut = await newPrompt("session-batch", "retried out");

    await setCreatedAt(later, 20);
    await setCreatedAt(older, 10);
    await setCreatedAt(captured, 15);
    await setCreatedAt(otherSession, 5);
    await setCreatedAt(retriedOut, 25);
    await mgr.markAsCaptured(captured);
    for (let i = 0; i < 4; i++) {
      await mgr.recordFailedAttempt(retriedOut);
    }

    const prompts = await mgr.getUncapturedPromptsForSession("session-batch");

    expect(prompts.map((prompt) => prompt.id)).toEqual([older, later]);
  });
});
