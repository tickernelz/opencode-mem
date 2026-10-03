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
} from "../src/storage/turso/schema-migrations.js";
import { TursoDb } from "../src/storage/turso/turso-db.js";

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

    const version = await applySchemaMigrations(db, USER_PROMPTS_MIGRATIONS, {
      dbPath,
      label: "test",
    });
    expect(version).toBe(1);
    await ensureUserPromptColumns(db);

    const again = await applySchemaMigrations(db, USER_PROMPTS_MIGRATIONS, {
      dbPath,
      label: "test",
    });
    expect(again).toBe(1);

    const row = await db.get<{ user_version?: number }>("PRAGMA user_version");
    expect(Number(row?.user_version)).toBe(1);
    await db.close();
  });

  it("migrates memory shards to session_id index (v2)", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "schema-mem-v2-"));
    const dbPath = join(baseDir, "shard.db");
    const native = await connect(dbPath);
    const db = new TursoDb(native);

    const { memoryShardMigrations } = await import("../src/storage/turso/schema-migrations.js");
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
    expect(version).toBe(2);

    const row = await db.get<{ session_id: string }>(
      `SELECT session_id FROM memories WHERE id = ?`,
      ["mem_legacy"]
    );
    expect(row?.session_id).toBe("sess_from_meta");
    await db.close();
  });
});
