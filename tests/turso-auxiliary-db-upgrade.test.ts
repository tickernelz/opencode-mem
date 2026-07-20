import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

describe("turso auxiliary database upgrades", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("preserves legacy prompts while adding newer columns", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-prompt-upgrade-"));
    const dbPath = join(baseDir, "user-prompts.db");
    const legacy = createClient({ url: `file:${dbPath}` });
    await legacy.batch(
      [
        `CREATE TABLE user_prompts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          project_path TEXT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          captured INTEGER DEFAULT 0,
          user_learning_captured BOOLEAN DEFAULT 0,
          linked_memory_id TEXT
        )`,
        {
          sql: `INSERT INTO user_prompts (
            id, session_id, message_id, project_path, content, created_at, captured
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            "prompt_legacy",
            "session_legacy",
            "message_legacy",
            "/legacy/project",
            "preserve this prompt",
            123,
            1,
          ],
        },
      ],
      "write"
    );
    legacy.close();

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const { userPromptManager } =
      await import("../src/services/user-prompt/user-prompt-manager.js");
    userPromptManager.reset();

    const prompt = await userPromptManager.getPromptById("prompt_legacy");
    expect(prompt?.content).toBe("preserve this prompt");
    expect(prompt?.capture_attempts).toBe(0);
    expect(prompt?.providerId).toBeNull();
    expect(prompt?.modelId).toBeNull();

    const verify = createClient({ url: `file:${dbPath}` });
    const columns = await verify.execute(`PRAGMA table_info(user_prompts)`);
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("capture_attempts");
    expect(names).toContain("provider_id");
    expect(names).toContain("model_id");
    verify.close();
  });
});
