import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";
import { Database } from "bun:sqlite";

// Each test runs the real migration: file renames behind prod's bounded
// file-lock retry can legitimately exceed the 5s default on loaded Windows.
const MIGRATION_TEST_TIMEOUT = 15000;
const migrationTest = (name: string, fn: () => void | Promise<void>) =>
  it(name, fn, MIGRATION_TEST_TIMEOUT);

describe("turso legacy migrator", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  async function createLegacyShard(
    dir: string,
    fileName: string,
    memories: Array<{ id: string; vector: Float32Array; content: string; containerTag: string }>
  ): Promise<string> {
    const dbPath = join(dir, fileName);
    const db = new Database(dbPath);

    db.exec(`CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          vector BLOB NOT NULL,
          tags_vector BLOB,
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
        )`);

    const insert = db.prepare(
      `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const memory of memories) {
      const blob = new Uint8Array(memory.vector.buffer);
      insert.run(memory.id, memory.content, blob, memory.containerTag, Date.now(), Date.now());
    }

    insert.finalize();
    db.close();
    return dbPath;
  }

  migrationTest("migrates legacy shard and writes sidecar plus global marker", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const vector = new Float32Array(768);
    vector[0] = 1;
    const scopeHash = "a1b2c3d4e5f67890";
    await createLegacyShard(projectsDir, `project_${scopeHash}_shard_0.db`, [
      {
        id: "mem_legacy_1",
        vector,
        content: "legacy memory",
        containerTag: `opencode_project_${scopeHash}`,
      },
    ]);

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    const sidecarPath = join(projectsDir, `project_${scopeHash}_shard_0.db.turso-migrate.json`);
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
    expect(sidecar.status).toBe("complete");
    expect(sidecar.expectedCount).toBe(1);
    expect(sidecar.sourceCount).toBe(1);
    expect(sidecar.skippedCount).toBe(0);

    const markerPath = join(baseDir, ".turso-migrated");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    expect(marker.shards?.length).toBe(1);

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const registered = await tursoShardManager.getAllShards("project", "");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.scopeHash).toBe(scopeHash);
    expect(registered[0]?.vectorCount).toBe(1);
  });

  for (const change of ["insert", "delete"] as const) {
    migrationTest(`keeps migration complete after a normal ${change}`, async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-completed-"));
      const projectsDir = join(baseDir, "projects");
      mkdirSync(projectsDir);
      const scopeHash = "abcdef0123456789";
      const dbPath = await createLegacyShard(projectsDir, `project_${scopeHash}_shard_0.db`, [
        {
          id: "original",
          vector: new Float32Array([1, 0, 0, 0]),
          content: "original memory",
          containerTag: `opencode_project_${scopeHash}`,
        },
      ]);
      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.embeddingDimensions = 4;
      CONFIG.databaseEncryptionEnabled = false;
      CONFIG.databaseEncryptionKey = undefined;
      const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      await runLegacyTursoMigration();
      const sidecarPath = `${dbPath}.turso-migrate.json`;
      const sidecar = readFileSync(sidecarPath, "utf-8");
      const markerPath = join(baseDir, ".turso-migrated");
      const marker = readFileSync(markerPath, "utf-8");
      const db = await tursoConnectionManager.getConnection(dbPath);
      if (change === "insert") {
        await db.run(`INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
          SELECT 'added', content, vector, container_tag, created_at, updated_at FROM memories`);
      } else {
        await db.run("DELETE FROM memories");
      }

      // A live lock makes any erroneous re-entry fail rather than silently
      // rewriting the historical counts. A completed shard needs no migration.
      writeFileSync(
        join(baseDir, ".turso-migrate.lock"),
        JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })
      );
      const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
      await closeTursoAndInvalidateCaches();
      await runLegacyTursoMigration();
      expect(readFileSync(sidecarPath, "utf-8")).toBe(sidecar);
      expect(readFileSync(markerPath, "utf-8")).toBe(marker);
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const shards = await tursoShardManager.getAllShards("project", scopeHash);
      expect(shards[0]?.vectorCount).toBe(change === "insert" ? 2 : 0);
    });
  }

  migrationTest("restores unreadable vectors despite a complete sidecar", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-complete-corrupt-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir);
    const dbPath = await createLegacyShard(projectsDir, "project_abcdef0123456789_shard_0.db", [
      {
        id: "recoverable",
        vector: new Float32Array([1, 0, 0, 0]),
        content: "preserved in backup",
        containerTag: "opencode_project_abcdef0123456789",
      },
    ]);
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 4;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;
    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    await runLegacyTursoMigration();
    const db = await tursoConnectionManager.getConnection(dbPath);
    await db.run("UPDATE memories SET vector = x'010203'");

    await runLegacyTursoMigration();

    const restoredDb = await tursoConnectionManager.getConnection(dbPath);
    const row = await restoredDb.get(
      "SELECT content, vector_extract(vector) AS vector FROM memories"
    );
    expect(row?.content).toBe("preserved in backup");
    expect(JSON.parse(String(row?.vector))).toEqual([1, 0, 0, 0]);
  });

  for (const loseLock of [false, true, "same-process"] as const) {
    migrationTest(`heartbeats insert batches (ownership lost: ${loseLock})`, async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-heartbeat-"));
      const projectsDir = join(baseDir, "projects");
      mkdirSync(projectsDir);
      const dbPath = await createLegacyShard(
        projectsDir,
        "project_abcdef0123456789_shard_0.db",
        Array.from({ length: 51 }, (_, i) => ({
          id: `batch-${i}`,
          vector: new Float32Array([1, 0, 0, 0]),
          content: "batch memory",
          containerTag: "opencode_project_abcdef0123456789",
        }))
      );
      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.embeddingDimensions = 4;
      CONFIG.databaseEncryptionEnabled = false;
      CONFIG.databaseEncryptionKey = undefined;
      const { TURSO_LOCK_STALE_MS, readLiveTursoLock } =
        await import("../src/services/turso/operation-lock.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
      const insert = tursoVectorSearch.insertVectorInTransaction;
      const lockPath = join(baseDir, ".turso-migrate.lock");
      const oldTimestamp = new Date(Date.now() - TURSO_LOCK_STALE_MS - 60_000).toISOString();
      let inserted = 0;
      tursoVectorSearch.insertVectorInTransaction = async function (tx, record) {
        if (inserted === 0) {
          const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
          writeFileSync(
            lockPath,
            JSON.stringify({
              ...lock,
              id: loseLock === true ? "foreign-acquisition" : lock.id,
              pid: loseLock === true ? 2147483647 : process.pid,
              timestamp: oldTimestamp,
            })
          );
          if (loseLock === "same-process") {
            expect(readLiveTursoLock(lockPath)).toBeNull();
            writeFileSync(
              lockPath,
              JSON.stringify({
                id: "successor",
                pid: process.pid,
                timestamp: new Date().toISOString(),
              }),
              { flag: "wx" }
            );
          }
        }
        if (inserted === 50) {
          const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
          expect(Date.parse(lock.timestamp)).toBeGreaterThan(Date.parse(oldTimestamp));
        }
        inserted++;
        return insert.call(this, tx, record);
      };
      try {
        const { runLegacyTursoMigration } =
          await import("../src/services/turso/legacy-migrator.js");
        if (loseLock) {
          await expect(runLegacyTursoMigration()).rejects.toThrow(
            /ownership lost.*aborting migration/
          );
          expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(false);
          const replacement = JSON.parse(readFileSync(lockPath, "utf-8"));
          expect(replacement.pid).toBe(loseLock === true ? 2147483647 : process.pid);
          if (loseLock === "same-process") expect(replacement.id).toBe("successor");
        } else {
          await runLegacyTursoMigration();
          expect(inserted).toBe(51);
        }
        const { tursoConnectionManager } =
          await import("../src/services/turso/connection-manager.js");
        const db = await tursoConnectionManager.getConnection(dbPath);
        const row = await db.get("SELECT COUNT(*) AS count FROM memories");
        expect(Number(row?.count)).toBe(loseLock ? 0 : 51);
      } finally {
        tursoVectorSearch.insertVectorInTransaction = insert;
      }
    });
  }

  migrationTest("resumes from backup after interrupted migration", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-resume-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const vector = new Float32Array(768);
    vector[0] = 1;
    const dbPath = await createLegacyShard(projectsDir, "project_resume_shard_0.db", [
      {
        id: "mem_resume_1",
        vector,
        content: "resume me",
        containerTag: "opencode_project_resume",
      },
    ]);

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");

    const backupPath = `${dbPath}.legacy.bak`;

    await tursoConnectionManager.closeConnection(dbPath);
    const { renameSync } = await import("node:fs");
    renameSync(dbPath, backupPath);

    const freshDb = await tursoConnectionManager.getConnection(dbPath);
    await tursoShardManager.initShardDb(freshDb);
    writeFileSync(
      `${dbPath}.turso-migrate.json`,
      JSON.stringify({ expectedCount: 1, importedCount: 0, status: "pending" }),
      "utf-8"
    );

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    const migratedDb = await tursoConnectionManager.getConnection(dbPath);
    const countRow = await migratedDb.get(`SELECT COUNT(*) as count FROM memories`);
    expect(Number(countRow?.count)).toBe(1);

    const restored = await migratedDb.get(`SELECT content FROM memories WHERE id = ?`, [
      "mem_resume_1",
    ]);
    expect(String(restored?.content)).toBe("resume me");
  });

  migrationTest(
    "does not skip migration when marker exists but shard sidecar is incomplete",
    async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-marker-"));
      const projectsDir = join(baseDir, "projects");
      mkdirSync(projectsDir, { recursive: true });

      const vector = new Float32Array(768);
      vector[0] = 1;
      await createLegacyShard(projectsDir, "project_marker_shard_0.db", [
        {
          id: "mem_marker_1",
          vector,
          content: "marker test",
          containerTag: "opencode_project_marker",
        },
      ]);

      writeFileSync(
        join(baseDir, ".turso-migrated"),
        JSON.stringify({ completedAt: new Date().toISOString(), shards: [] }),
        "utf-8"
      );

      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.embeddingDimensions = 768;

      const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
      await runLegacyTursoMigration();

      const sidecarPath = join(projectsDir, "project_marker_shard_0.db.turso-migrate.json");
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      expect(sidecar.status).toBe("complete");
    }
  );

  migrationTest("aborts migration when legacy vector blob is unreadable", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-corrupt-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const dbPath = join(projectsDir, "project_corrupt_shard_0.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          vector BLOB NOT NULL,
          container_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
    const insertCorrupt = db.prepare(
      `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertCorrupt.run(
      "mem_corrupt_1",
      "bad vector",
      new Uint8Array([1, 2, 3]),
      "opencode_project_corrupt",
      Date.now(),
      Date.now()
    );
    insertCorrupt.finalize();
    db.close();

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await expect(runLegacyTursoMigration()).rejects.toThrow(/unreadable vectors/);

    expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(false);
  });

  migrationTest("does not skip migration when complete sidecar lacks vector index", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-fake-sidecar-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const vector = new Float32Array(768);
    vector[0] = 1;
    const dbPath = await createLegacyShard(projectsDir, "project_fake_sidecar_shard_0.db", [
      {
        id: "mem_fake_1",
        vector,
        content: "needs real migration",
        containerTag: "opencode_project_fakesidecar",
      },
    ]);

    writeFileSync(
      `${dbPath}.turso-migrate.json`,
      JSON.stringify({
        sourceCount: 1,
        expectedCount: 1,
        importedCount: 1,
        skippedCount: 0,
        status: "complete",
      }),
      "utf-8"
    );
    writeFileSync(
      join(baseDir, ".turso-migrated"),
      JSON.stringify({ completedAt: new Date().toISOString(), shards: [] }),
      "utf-8"
    );

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(dbPath);
    const indexRow = await db.get(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='memories_vec_idx'`
    );
    expect(indexRow).toBeNull();
    const probe = await db.get(`SELECT vector_extract(vector) AS extracted FROM memories LIMIT 1`);
    expect(String(probe?.extracted || "").length).toBeGreaterThan(0);
    const meta = await db.get(
      `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
    );
    expect(Number(meta?.value)).toBe(768);
  });

  migrationTest(
    "does not skip migration when index exists but embedding dimensions mismatch",
    async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-dims-mismatch-"));
      const projectsDir = join(baseDir, "projects");
      mkdirSync(projectsDir, { recursive: true });

      const scopeHash = "d1d2d3d4e5f67890";
      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.embeddingDimensions = 768;

      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

      const shard = await tursoShardManager.createShard("project", scopeHash, 0);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const vector = new Float32Array(768);
      vector[0] = 1;
      await tursoVectorSearch.insertVector(db, {
        id: "mem_dims_mismatch_1",
        content: "turso shard with wrong metadata dims",
        vector,
        containerTag: `opencode_project_${scopeHash}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await db.run(
        `INSERT OR REPLACE INTO shard_metadata (key, value) VALUES ('embedding_dimensions', ?)`,
        ["384"]
      );
      await tursoConnectionManager.closeConnection(shard.dbPath);

      const sidecarPath = `${shard.dbPath}.turso-migrate.json`;
      if (existsSync(sidecarPath)) {
        rmSync(sidecarPath);
      }

      const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
      await runLegacyTursoMigration();

      expect(existsSync(`${shard.dbPath}.legacy.bak`)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8"));
      expect(sidecar.status).toBe("complete");

      const migratedDb = await tursoConnectionManager.getConnection(shard.dbPath);
      const meta = await migratedDb.get(
        `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
      );
      expect(Number(meta?.value)).toBe(768);
    }
  );

  migrationTest(
    "repairs the active shard flag while reconciling an existing registry",
    async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-registry-"));
      const scopeHash = "1122334455667788";

      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.embeddingDimensions = 4;

      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const shard = await tursoShardManager.createShard("project", scopeHash, 0);
      const metadataDb = await tursoConnectionManager.getConnection(join(baseDir, "metadata.db"));
      await metadataDb.run(`UPDATE shards SET is_active = 0 WHERE id = ?`, [shard.id]);

      const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
      await runLegacyTursoMigration();

      const active = await tursoShardManager.getActiveShard("project", scopeHash);
      expect(active?.id).toBe(shard.id);
      expect(active?.isActive).toBe(true);
    }
  );
});
