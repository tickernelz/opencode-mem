import { afterAll, beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect home to a temporary directory BEFORE importing config so that
// CONFIG.storagePath resolves under the test sandbox.
const sandbox = mkdtempSync(join(tmpdir(), "opencode-mem-claim-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;

const { UserPromptManager } = await import("../src/services/user-prompt/user-prompt-manager.js");

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  // Best-effort cleanup. On Windows the SQLite connection may still hold a
  // lock on the WAL file even after the process is shutting down, which can
  // surface as EBUSY. Failing here would mask test results, so we swallow.
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("UserPromptManager.claimPrompt / releaseClaim", () => {
  let mgr: InstanceType<typeof UserPromptManager>;
  let activeIds: string[];

  beforeEach(() => {
    mgr = new UserPromptManager();
    activeIds = [];
  });

  afterEach(() => {
    // Clean up rows the test inserted so subsequent tests start with an
    // empty table.
    for (const id of activeIds) {
      try {
        mgr.deletePrompt(id);
      } catch {
        // ignore
      }
    }
  });

  function getRawCaptured(id: string): number {
    const raw = (
      mgr as unknown as {
        db: { prepare: (s: string) => { get: (a: string) => { captured: number } | undefined } };
      }
    ).db
      .prepare(`SELECT captured FROM user_prompts WHERE id = ?`)
      .get(id);
    return raw?.captured ?? -1;
  }

  function setCreatedAt(id: string, createdAt: number): void {
    (
      mgr as unknown as {
        db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } };
      }
    ).db
      .prepare(`UPDATE user_prompts SET created_at = ? WHERE id = ?`)
      .run(createdAt, id);
  }

  function newPrompt(sessionId = "session-test", content = "hello") {
    const id = mgr.savePrompt(
      sessionId,
      `msg-${Date.now()}-${Math.random()}`,
      "/tmp/proj",
      content
    );
    activeIds.push(id);
    return id;
  }

  it("claimPrompt transitions captured 0 → 2 and returns true", () => {
    const id = newPrompt();
    expect(mgr.claimPrompt(id)).toBe(true);
    expect(getRawCaptured(id)).toBe(2);
  });

  it("claimPrompt returns false when the row is already claimed", () => {
    const id = newPrompt();
    expect(mgr.claimPrompt(id)).toBe(true);
    expect(mgr.claimPrompt(id)).toBe(false);
  });

  it("releaseClaim transitions captured 2 → 0 and exposes the row to retry", () => {
    const id = newPrompt("session-release");
    expect(mgr.claimPrompt(id)).toBe(true);
    expect(mgr.releaseClaim(id)).toBe(true);
    expect(getRawCaptured(id)).toBe(0);

    const next = mgr.getLastUncapturedPrompt("session-release");
    expect(next).not.toBeNull();
    expect(next!.id).toBe(id);
  });

  it("releaseClaim is a no-op when the row is already captured=1", () => {
    const id = newPrompt();
    mgr.claimPrompt(id);
    mgr.markAsCaptured(id);

    expect(mgr.releaseClaim(id)).toBe(false);
    expect(getRawCaptured(id)).toBe(1);
  });

  it("releaseClaim is a no-op when the row was never claimed", () => {
    const id = newPrompt();
    expect(mgr.releaseClaim(id)).toBe(false);
    expect(getRawCaptured(id)).toBe(0);
  });

  it("supports a full claim → release → re-claim retry cycle", () => {
    const id = newPrompt();
    expect(mgr.claimPrompt(id)).toBe(true);
    expect(mgr.releaseClaim(id)).toBe(true);
    expect(mgr.claimPrompt(id)).toBe(true);
    expect(getRawCaptured(id)).toBe(2);
  });

  it("ignores prompts that have exceeded max retries", () => {
    const id = mgr.savePrompt("session-retries", "msg-1", "/path", "hello retry");
    activeIds.push(id);

    for (let i = 0; i < 4; i++) {
      mgr.recordFailedAttempt(id);
    }

    const prompt = mgr.getLastUncapturedPrompt("session-retries");
    expect(prompt).toBeNull();
  });

  it("returns all uncaptured prompts for a session oldest first", () => {
    const later = newPrompt("session-batch", "later");
    const older = newPrompt("session-batch", "older");
    const captured = newPrompt("session-batch", "captured");
    const otherSession = newPrompt("session-other", "other");
    const retriedOut = newPrompt("session-batch", "retried out");

    setCreatedAt(later, 20);
    setCreatedAt(older, 10);
    setCreatedAt(captured, 15);
    setCreatedAt(otherSession, 5);
    setCreatedAt(retriedOut, 25);
    mgr.markAsCaptured(captured);
    for (let i = 0; i < 4; i++) {
      mgr.recordFailedAttempt(retriedOut);
    }

    const prompts = mgr.getUncapturedPromptsForSession("session-batch");

    expect(prompts.map((prompt) => prompt.id)).toEqual([older, later]);
  });

  it("stores repeated delivery of the same session message only once", () => {
    const first = mgr.savePrompt(
      "session-duplicate",
      "message-duplicate",
      "/tmp/proj",
      "same prompt"
    );
    const second = mgr.savePrompt(
      "session-duplicate",
      "message-duplicate",
      "/tmp/proj",
      "same prompt"
    );
    activeIds.push(first, second);

    expect(second).toBe(first);
    expect(mgr.countUnanalyzedForUserLearning()).toBe(1);
  });

  it("does not reopen profile learning when a handled message is delivered again", () => {
    const first = mgr.savePrompt(
      "session-handled",
      "message-handled",
      "/tmp/proj",
      "already learned"
    );
    mgr.markAsUserLearningCaptured(first);

    const repeated = mgr.savePrompt(
      "session-handled",
      "message-handled",
      "/tmp/proj",
      "already learned"
    );
    activeIds.push(first, repeated);

    expect(repeated).toBe(first);
    expect(mgr.countUnanalyzedForUserLearning()).toBe(0);
  });

  it("keeps the same message id distinct across sessions", () => {
    const first = mgr.savePrompt("session-one", "shared-message", "/tmp/proj", "first session");
    const second = mgr.savePrompt("session-two", "shared-message", "/tmp/proj", "second session");
    activeIds.push(first, second);

    expect(second).not.toBe(first);
    expect(mgr.countUnanalyzedForUserLearning()).toBe(2);
  });
});
