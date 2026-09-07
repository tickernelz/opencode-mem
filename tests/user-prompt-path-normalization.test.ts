import { afterAll, beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TursoDb } from "../src/services/turso/turso-db.js";

const sandbox = mkdtempSync(join(tmpdir(), "opencode-mem-path-home-"));
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

describe("UserPromptManager project path normalization", () => {
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

  async function saveCapturedPrompt(projectPath: string) {
    const id = await mgr.savePrompt(
      "session-path-test",
      `msg-${Date.now()}-${Math.random()}`,
      projectPath,
      "hello"
    );
    await mgr.markAsCaptured(id);
    activeIds.push(id);
    return id;
  }

  it("getCapturedPrompts matches paths regardless of separator style", async () => {
    const storedPath = "C:\\workspace\\proj";
    await saveCapturedPrompt(storedPath);

    const forwardSlashQuery = await mgr.getCapturedPrompts("C:/workspace/proj");
    expect(forwardSlashQuery).toHaveLength(1);

    const backslashQuery = await mgr.getCapturedPrompts("C:\\workspace\\proj");
    expect(backslashQuery).toHaveLength(1);
  });

  it("searchPrompts matches paths regardless of separator style", async () => {
    const storedPath = "D:\\repos\\app";
    await saveCapturedPrompt(storedPath);

    const results = await mgr.searchPrompts("hello", "D:/repos/app");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("hello");
  });
});
