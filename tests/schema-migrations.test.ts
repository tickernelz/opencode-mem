import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@tursodatabase/database";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";
import {
  applySchemaMigrations,
  USER_PROMPTS_MIGRATIONS,
  ensureUserPromptColumns,
} from "../src/services/turso/schema-migrations.js";
import { TursoDb } from "../src/services/turso/turso-db.js";

describe("schema migrations", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("applies user_version migrations idempotently", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "schema-mig-"));
    const dbPath = join(baseDir, "user-prompts.db");
    const native = await connect(dbPath);
    const db = new TursoDb(native);

    await applySchemaMigrations(db, USER_PROMPTS_MIGRATIONS.slice(0, 1), { dbPath, label: "v1" });
    await db.run(
      "INSERT INTO user_prompts (id, session_id, message_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ["existing", "session", "message", "Existing request", 1]
    );
    const version = await applySchemaMigrations(db, USER_PROMPTS_MIGRATIONS, {
      dbPath,
      label: "test",
    });
    expect(version).toBe(2);
    await ensureUserPromptColumns(db);

    const again = await applySchemaMigrations(db, USER_PROMPTS_MIGRATIONS, {
      dbPath,
      label: "test",
    });
    expect(again).toBe(2);

    const row = await db.get<{ user_version?: number }>("PRAGMA user_version");
    expect(Number(row?.user_version)).toBe(2);
    expect((await db.get("SELECT content FROM user_prompts WHERE id = 'existing'"))?.content).toBe(
      "Existing request"
    );
    expect(await db.get("SELECT COUNT(*) AS n FROM pending_capture_evidence")).toMatchObject({
      n: 0,
    });
    await db.close();
  });

  it("migrates memory shards through session_id (v2) and deleted_at (v3)", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "schema-mem-v3-"));
    const dbPath = join(baseDir, "shard.db");
    const native = await connect(dbPath);
    const db = new TursoDb(native);

    const { memoryShardMigrations } = await import("../src/services/turso/schema-migrations.js");
    const migrations = memoryShardMigrations(8);
    await applySchemaMigrations(db, [migrations[0]!], {
      dbPath,
      label: "memory-shard-v1",
    });

    await db.run(
      `INSERT INTO memories (
        id, content, vector, container_tag, created_at, updated_at, metadata
      ) VALUES (?, ?, vector32(?), ?, ?, ?, ?)`,
      [
        "mem_legacy",
        "legacy row",
        JSON.stringify([1, 0, 0, 0, 0, 0, 0, 0]),
        "tag",
        Date.now(),
        Date.now(),
        JSON.stringify({ sessionID: "sess_from_meta" }),
      ]
    );

    const version = await applySchemaMigrations(db, migrations, {
      dbPath,
      label: "memory-shard",
    });
    expect(version).toBe(3);

    const row = await db.get<{ session_id: string; deleted_at: number | null }>(
      `SELECT session_id, deleted_at FROM memories WHERE id = ?`,
      ["mem_legacy"]
    );
    expect(row?.session_id).toBe("sess_from_meta");
    expect(row?.deleted_at ?? null).toBeNull();
    await db.close();
  });
});
