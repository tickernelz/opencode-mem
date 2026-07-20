import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

describe("turso legacy migrator", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  async function createLegacyShard(
    dir: string,
    fileName: string,
    memories: Array<{ id: string; vector: Float32Array; content: string; containerTag: string }>
  ): Promise<string> {
    const dbPath = join(dir, fileName);
    const client = createClient({ url: `file:${dbPath}` });
    const dims = memories[0]?.vector.length ?? 768;

    await client.batch(
      [
        `CREATE TABLE memories (
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
        )`,
      ],
      "write"
    );

    for (const memory of memories) {
      const blob = new Uint8Array(memory.vector.buffer);
      await client.execute({
        sql: `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [memory.id, memory.content, blob, memory.containerTag, Date.now(), Date.now()],
      });
    }

    await client.close();
    return dbPath;
  }

  it("migrates legacy shard and writes sidecar plus global marker", async () => {
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

  it("resumes from backup after interrupted migration", async () => {
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

  it("does not skip migration when marker exists but shard sidecar is incomplete", async () => {
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
  });

  it("aborts migration when legacy vector blob is unreadable", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-corrupt-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const dbPath = join(projectsDir, "project_corrupt_shard_0.db");
    const client = createClient({ url: `file:${dbPath}` });
    await client.batch(
      [
        `CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          vector BLOB NOT NULL,
          container_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      ],
      "write"
    );
    await client.execute({
      sql: `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "mem_corrupt_1",
        "bad vector",
        new Uint8Array([1, 2, 3]),
        "opencode_project_corrupt",
        Date.now(),
        Date.now(),
      ],
    });
    await client.close();

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await expect(runLegacyTursoMigration()).rejects.toThrow(/unreadable vectors/);

    expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(false);
  });

  it("does not skip migration when complete sidecar lacks vector index", async () => {
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

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(dbPath);
    const indexRow = await db.get(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='memories_vec_idx'`
    );
    expect(indexRow).toBeTruthy();
    const probe = await db.get(`SELECT vector_extract(vector) AS extracted FROM memories LIMIT 1`);
    expect(String(probe?.extracted || "").length).toBeGreaterThan(0);
  });

  it("does not skip migration when index exists but embedding dimensions mismatch", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-dims-mismatch-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const scopeHash = "d1d2d3d4e5f67890";
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
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
  });

  it("repairs the active shard flag while reconciling an existing registry", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-registry-"));
    const scopeHash = "1122334455667788";

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 4;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const metadataDb = await tursoConnectionManager.getConnection(join(baseDir, "metadata.db"));
    await metadataDb.run(`UPDATE shards SET is_active = 0 WHERE id = ?`, [shard.id]);

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    const active = await tursoShardManager.getActiveShard("project", scopeHash);
    expect(active?.id).toBe(shard.id);
    expect(active?.isActive).toBe(true);
  });
});
