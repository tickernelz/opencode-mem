import { describe, expect, it, afterEach } from "bun:test";
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
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";
import {
  collectReleasedSqliteHandles,
  renameSqliteDatabase,
  withSqliteFileLockRetry,
} from "../src/storage/turso/sqlite-handle-release.js";

describe("turso ready gate", () => {
  let baseDir: string;
  let restoreConfig: (() => void) | undefined;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
    restoreConfig?.();
    restoreConfig = undefined;
  });

  async function withStorage() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-ready-"));
    const { CONFIG } = await import("../src/config.js");
    const previous = {
      storagePath: CONFIG.storagePath,
      embeddingDimensions: CONFIG.embeddingDimensions,
      databaseEncryptionEnabled: CONFIG.databaseEncryptionEnabled,
      databaseEncryptionKey: CONFIG.databaseEncryptionKey,
    };
    restoreConfig = () => Object.assign(CONFIG, previous);
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;
  }

  const scopeHash = "0123456789abcdef";
  const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : i === 1 ? 0.5 : 0));
  const tagsVector = vector.map((value) => (value === 0 ? 0 : -value));

  async function createIndexedShard(completedLegacyMigration: boolean): Promise<string> {
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir);
    const dbPath = join(projectsDir, `project_${scopeHash}_shard_0.db`);
    const client = createClient({ url: `file:${dbPath}`, concurrency: 1 });
    try {
      await client.execute(`CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL,
        vector F32_BLOB(1024) NOT NULL, tags_vector F32_BLOB(1024),
        container_tag TEXT NOT NULL, tags TEXT, type TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        metadata TEXT, display_name TEXT, user_name TEXT, user_email TEXT,
        project_path TEXT, project_name TEXT, git_repo_url TEXT,
        is_pinned INTEGER DEFAULT 0
      )`);
      for (const [id, tags] of [
        ["tagged", tagsVector],
        ["untagged", null],
      ] as const) {
        await client.execute({
          sql: `INSERT INTO memories VALUES (
            ?, ?, vector32(?), CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
          args: [
            id,
            `synthetic ${id} memory`,
            JSON.stringify(vector),
            tags === null ? null : JSON.stringify(tags),
            tags === null ? null : JSON.stringify(tags),
            `opencode_project_${scopeHash}`,
            tags === null ? null : '["migration"]',
            "project",
            123,
            456,
            '{"synthetic":true}',
            "Test User",
            "test-user",
            "test@example.invalid",
            "/synthetic/project",
            "fixture",
            "https://example.invalid/repo",
            1,
          ],
        });
      }
      await client.execute("CREATE TABLE shard_metadata (key TEXT PRIMARY KEY, value TEXT)");
      await client.execute("INSERT INTO shard_metadata VALUES ('embedding_dimensions', '1024')");
      await client.execute(
        "INSERT INTO shard_metadata VALUES ('embedding_model', 'voyage-4-lite')"
      );
      for (const column of ["vector", "tags_vector"]) {
        await client.execute(`CREATE INDEX memories_${column}_idx ON memories (
          libsql_vector_idx(${column}, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=20')
        )`);
      }
    } finally {
      client.close();
    }
    // libsql can keep native handles until GC; Windows renames need them gone.
    await collectReleasedSqliteHandles();
    if (completedLegacyMigration) {
      writeFileSync(
        `${dbPath}.turso-migrate.json`,
        JSON.stringify({
          sourceCount: 2,
          expectedCount: 2,
          importedCount: 2,
          skippedCount: 0,
          status: "complete",
        })
      );
      writeFileSync(
        join(baseDir, ".turso-migrated"),
        JSON.stringify({
          completedAt: "2026-01-01T00:00:00Z",
          shards: [{ path: dbPath, expectedCount: 2, importedCount: 2 }],
        })
      );
    }
    return dbPath;
  }

  async function assertMigratedShard(dbPath: string): Promise<void> {
    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(dbPath);
    const rows = await db.all(`SELECT *, vector_extract(vector) AS extracted,
      CASE WHEN tags_vector IS NULL THEN NULL ELSE vector_extract(tags_vector) END AS extracted_tags
      FROM memories ORDER BY id`);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.content).toBe(`synthetic ${row.id} memory`);
      expect(JSON.parse(String(row.extracted))).toEqual(vector);
      expect(row.container_tag).toBe(`opencode_project_${scopeHash}`);
      expect(row.type).toBe("project");
      expect(row.created_at).toBe(123);
      expect(row.updated_at).toBe(456);
      expect(row.metadata).toBe('{"synthetic":true}');
      expect(row.display_name).toBe("Test User");
      expect(row.user_name).toBe("test-user");
      expect(row.user_email).toBe("test@example.invalid");
      expect(row.project_path).toBe("/synthetic/project");
      expect(row.project_name).toBe("fixture");
      expect(row.git_repo_url).toBe("https://example.invalid/repo");
      expect(row.is_pinned).toBe(1);
    }
    expect(rows[0]?.id).toBe("tagged");
    expect(rows[0]?.tags).toBe('["migration"]');
    expect(JSON.parse(String(rows[0]?.extracted_tags))).toEqual(tagsVector);
    expect(rows[1]?.id).toBe("untagged");
    expect(rows[1]?.tags).toBeNull();
    expect(rows[1]?.tags_vector).toBeNull();
    const metadata = await db.all("SELECT key, value FROM shard_metadata ORDER BY key");
    expect(metadata).toEqual([
      { key: "embedding_dimensions", value: "1024" },
      { key: "embedding_model", value: "voyage-4-lite" },
    ]);
    const { tursoShardManager } = await import("../src/storage/turso/shard-manager.js");
    const shards = await tursoShardManager.getAllShards("project", "");
    expect(shards).toHaveLength(1);
    expect(shards[0]?.scopeHash).toBe(scopeHash);
    expect(shards[0]?.vectorCount).toBe(2);
    expect(shards[0]?.isActive).toBe(true);
    expect(existsSync(join(baseDir, ".tursodb-engine-v1"))).toBe(true);
    expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(true);
  }

  it("runs legacy migration once and initializes metadata", async () => {
    await withStorage();
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = join(baseDir, "new-store");

    const { ensureTursoReady } = await import("../src/storage/turso/ready.js");
    await ensureTursoReady();
    await ensureTursoReady();

    expect(existsSync(join(CONFIG.storagePath, "metadata.db"))).toBe(true);
  });

  for (const completedLegacyMigration of [false, true]) {
    it(`migrates indexed libSQL shards through startup (legacy marker: ${completedLegacyMigration})`, async () => {
      await withStorage();
      const dbPath = await createIndexedShard(completedLegacyMigration);
      const { ensureTursoReady } = await import("../src/storage/turso/ready.js");
      await ensureTursoReady();
      await assertMigratedShard(dbPath);
      const backups = () =>
        readdirSync(join(baseDir, "projects")).filter(
          (name) => name.includes(".pre-tursodb-") && name.endsWith(".bak")
        );
      expect(backups()).toHaveLength(1);
      const marker = readFileSync(join(baseDir, ".tursodb-engine-v1"), "utf-8");
      const { closeTursoAndInvalidateCaches } = await import("../src/storage/turso/lifecycle.js");
      await closeTursoAndInvalidateCaches();
      await ensureTursoReady();
      await assertMigratedShard(dbPath);
      expect(backups()).toHaveLength(1);
      expect(readFileSync(join(baseDir, ".tursodb-engine-v1"), "utf-8")).toBe(marker);
    }, 15000);
  }

  it("recovers an interrupted re-embed swap before converting its libSQL indexes", async () => {
    await withStorage();
    const dbPath = await createIndexedShard(true);
    const stagedPath = `${dbPath}.reembed-fixture.tmp`;
    // Simulate an interrupted re-embed: active path vacated, staged replacement present.
    // Use the production Windows-safe rename helper — raw renameSync races libsql GC (EBUSY).
    await withSqliteFileLockRetry(() => renameSqliteDatabase(dbPath, stagedPath));
    writeFileSync(
      `${dbPath}.reembed-swap.json`,
      JSON.stringify({
        dbPath,
        stagedPath,
        backupPath: `${dbPath}.pre-reembed-fixture.bak`,
      })
    );
    const { ensureTursoReady } = await import("../src/storage/turso/ready.js");
    await ensureTursoReady();
    await assertMigratedShard(dbPath);
    expect(existsSync(stagedPath)).toBe(false);
    expect(existsSync(`${dbPath}.reembed-swap.json`)).toBe(false);
  }, 15000);

  it("throws when migration lock is held by another live process", async () => {
    await withStorage();

    writeFileSync(
      join(baseDir, ".turso-migrate.lock"),
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      "utf-8"
    );

    const { runLegacyTursoMigration } = await import("../src/storage/turso/legacy-migrator.js");
    await expect(runLegacyTursoMigration()).rejects.toThrow(/locked by another process/);
  });
});
