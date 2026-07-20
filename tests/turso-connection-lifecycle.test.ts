import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("turso connection lifecycle", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("reopens databases after closeTursoAndInvalidateCaches", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-lifecycle-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { userPromptManager } =
      await import("../src/services/user-prompt/user-prompt-manager.js");
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");

    const id = await userPromptManager.savePrompt("sess-1", "msg-1", "/tmp/project", "hello");
    expect(id).toBeTruthy();

    await closeTursoAndInvalidateCaches();

    const prompt = await userPromptManager.getPromptById(id);
    expect(prompt?.content).toBe("hello");
  });

  it("does not leak an in-flight open across closeAll", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-lifecycle-race-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const dbPath = join(baseDir, "race.db");

    const opening = tursoConnectionManager.getConnection(dbPath);
    await Promise.all([opening, tursoConnectionManager.closeAll()]);

    const reopened = await tursoConnectionManager.getConnection(dbPath);
    await reopened.run(`CREATE TABLE IF NOT EXISTS lifecycle_probe (id INTEGER PRIMARY KEY)`);
    expect(
      await reopened.get(`SELECT name FROM sqlite_master WHERE name = 'lifecycle_probe'`)
    ).toBeTruthy();
  });
});
