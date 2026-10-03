import { afterEach, describe, expect, it } from "bun:test";
import { createClient } from "@libsql/client";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@tursodatabase/database";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

const MIGRATION_TEST_TIMEOUT = 15000;
const migrationTest = (name: string, fn: () => void | Promise<void>) =>
  it(name, fn, MIGRATION_TEST_TIMEOUT);

describe("turso engine migrator", () => {
  let baseDir: string;
  let restoreConfig: (() => void) | undefined;

  afterEach(async () => {
    restoreConfig?.();
    restoreConfig = undefined;
    await cleanupTursoTestDirectory(baseDir);
  });

  async function withStorage() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-engine-"));
    mkdirSync(join(baseDir, "projects"), { recursive: true });
    const { CONFIG } = await import("../src/config.js");
    const previous = {
      storagePath: CONFIG.storagePath,
      embeddingDimensions: CONFIG.embeddingDimensions,
      databaseEncryptionEnabled: CONFIG.databaseEncryptionEnabled,
      databaseEncryptionKey: CONFIG.databaseEncryptionKey,
    };
    restoreConfig = () => {
      CONFIG.storagePath = previous.storagePath;
      CONFIG.embeddingDimensions = previous.embeddingDimensions;
      CONFIG.databaseEncryptionEnabled = previous.databaseEncryptionEnabled;
      CONFIG.databaseEncryptionKey = previous.databaseEncryptionKey;
    };
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 4;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;
  }

  migrationTest("is a no-op when the engine marker already exists", async () => {
    await withStorage();
    const marker = join(baseDir, ".tursodb-engine-v1");
    writeFileSync(marker, JSON.stringify({ migratedAt: "already" }));

    const { runTursoEngineMigration } = await import("../src/storage/turso/engine-migrator.js");
    await runTursoEngineMigration();
    expect(JSON.parse(readFileSync(marker, "utf-8")).migratedAt).toBe("already");
  });

  migrationTest("writes marker when storage has no databases", async () => {
    await withStorage();
    const { runTursoEngineMigration } = await import("../src/storage/turso/engine-migrator.js");
    await runTursoEngineMigration();
    expect(existsSync(join(baseDir, ".tursodb-engine-v1"))).toBe(true);
  });

  migrationTest("rewrites a DiskANN shard with NULL tags_vector into tursodb", async () => {
    await withStorage();
    const dbPath = join(baseDir, "projects", "project_a1b2c3d4e5f67890_shard_0.db");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await client.execute(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          vector F32_BLOB(4) NOT NULL,
          tags_vector F32_BLOB(4),
          container_tag TEXT NOT NULL,
          tags TEXT,
          type TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          metadata TEXT,
          display_name TEXT,
          user_name TEXT,
          user_email TEXT,
          project_path TEXT,
          project_name TEXT,
          git_repo_url TEXT,
          is_pinned INTEGER DEFAULT 0
        )
      `);
      await client.execute({
        sql: `INSERT INTO memories (id, content, vector, tags_vector, container_tag, created_at, updated_at)
              VALUES (?, ?, vector32(?), NULL, ?, ?, ?)`,
        args: [
          "mem_engine_null_tags",
          "engine migrate me",
          "[0,1,0,0]",
          "opencode_project_a1b2c3d4e5f67890",
          Date.now(),
          Date.now(),
        ],
      });
      await client.execute(
        `CREATE INDEX memories_vector_idx ON memories (libsql_vector_idx(vector))`
      );
    } finally {
      client.close();
    }

    const { runTursoEngineMigration } = await import("../src/storage/turso/engine-migrator.js");
    await runTursoEngineMigration();

    expect(existsSync(join(baseDir, ".tursodb-engine-v1"))).toBe(true);
    expect(
      readdirSync(join(baseDir, "projects")).some((name) => name.includes(".pre-tursodb-"))
    ).toBe(true);

    const opened = await connect(dbPath, { experimental: ["encryption"] });
    try {
      const rows = await opened.prepare("SELECT id, content FROM memories").all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("mem_engine_null_tags");
      expect(rows[0]?.content).toBe("engine migrate me");
    } finally {
      await opened.close();
    }
  });

  migrationTest("skips shards that already open with @tursodatabase/database", async () => {
    await withStorage();
    const dbPath = join(baseDir, "projects", "project_a1b2c3d4e5f67890_shard_0.db");
    const db = await connect(dbPath, { experimental: ["encryption"] });
    try {
      await db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)`);
      await db.prepare(`INSERT INTO memories VALUES (?, ?)`).run("mem_ok", "already tursodb");
    } finally {
      await db.close();
    }

    const { runTursoEngineMigration } = await import("../src/storage/turso/engine-migrator.js");
    await runTursoEngineMigration();

    expect(existsSync(join(baseDir, ".tursodb-engine-v1"))).toBe(true);
    expect(
      readdirSync(join(baseDir, "projects")).some((name) => name.includes(".pre-tursodb-"))
    ).toBe(false);

    const reopened = await connect(dbPath, { experimental: ["encryption"] });
    try {
      const row = await reopened.prepare("SELECT content FROM memories WHERE id = ?").get("mem_ok");
      expect(row?.content).toBe("already tursodb");
    } finally {
      await reopened.close();
    }
  });
});
