import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

const SCOPE_HASH = "0123456789abcdef";

describe("turso re-embed migration safety", () => {
  let baseDir: string;
  let restoreEmbedding: (() => void) | undefined;

  afterEach(async () => {
    restoreEmbedding?.();
    restoreEmbedding = undefined;
    await cleanupTursoTestDirectory(baseDir);
  });

  async function createSourceShard() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-reembed-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 2;
    CONFIG.databaseEncryptionEnabled = false;
    CONFIG.databaseEncryptionKey = undefined;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const shard = await tursoShardManager.createShard("project", SCOPE_HASH, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    for (const [index, id] of ["mem_one", "mem_two"].entries()) {
      await tursoVectorSearch.insertVector(db, {
        id,
        content: `content ${index}`,
        vector: new Float32Array([1, index]),
        tagsVector: new Float32Array([0, 1]),
        containerTag: `opencode_project_${SCOPE_HASH}`,
        tags: "alpha,beta",
        type: "project",
        createdAt: 100 + index,
        updatedAt: 200 + index,
        metadata: JSON.stringify({ source: "test", index }),
        displayName: `Memory ${index}`,
        projectPath: `/project/${index}`,
      });
      await tursoShardManager.incrementVectorCount(shard.id);
    }
    await tursoVectorSearch.pinMemory(db, "mem_one");
    return shard;
  }

  async function stubEmbedding(failOn?: string) {
    const { embeddingService } = await import("../src/services/embedding.js");
    const service = embeddingService as any;
    const original = {
      warmup: service.warmup,
      clearCache: service.clearCache,
      embedWithTimeout: service.embedWithTimeout,
    };
    service.warmup = async () => {};
    service.clearCache = () => {};
    service.embedWithTimeout = async (text: string) => {
      if (failOn && text.includes(failOn)) throw new Error("synthetic embedding failure");
      return new Float32Array([1, 0, 0, 0]);
    };
    restoreEmbedding = () => Object.assign(service, original);
  }

  it("stages a complete replacement and preserves metadata, tags, and pins", async () => {
    const shard = await createSourceShard();
    await stubEmbedding();
    const { CONFIG } = await import("../src/config.js");
    CONFIG.embeddingDimensions = 4;

    const { migrationService } = await import("../src/services/migration-service.js");
    const result = await migrationService.migrateToNewModel("re-embed");

    expect(result.success).toBe(true);
    expect(result.deletedShards).toBe(0);
    expect(result.reEmbeddedMemories).toBe(2);
    expect(
      readdirSync(join(baseDir, "projects")).some((name) => name.includes(".pre-reembed-"))
    ).toBe(true);

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const rows = await db.all(
      `SELECT *, vector_extract(vector) AS vector_json FROM memories ORDER BY id`
    );
    expect(rows).toHaveLength(2);
    expect(String(rows[0]?.tags)).toBe("alpha,beta");
    expect(String(rows[0]?.display_name)).toBe("Memory 0");
    expect(Number(rows[0]?.is_pinned)).toBe(1);
    expect(JSON.parse(String(rows[0]?.vector_json))).toHaveLength(4);
    const metadata = await db.get(
      `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
    );
    expect(Number(metadata?.value)).toBe(4);
  });

  it("leaves the source shard untouched when any embedding fails", async () => {
    const shard = await createSourceShard();
    await stubEmbedding("content 1");
    const { CONFIG } = await import("../src/config.js");
    CONFIG.embeddingDimensions = 4;

    const { migrationService } = await import("../src/services/migration-service.js");
    const result = await migrationService.migrateToNewModel("re-embed");

    expect(result.success).toBe(false);
    expect(result.error).toContain("synthetic embedding failure");
    expect(
      readdirSync(join(baseDir, "projects")).some((name) => name.includes(".pre-reembed-"))
    ).toBe(false);

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const count = await db.get(`SELECT COUNT(*) AS count FROM memories`);
    expect(Number(count?.count)).toBe(2);
    const metadata = await db.get(
      `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
    );
    expect(Number(metadata?.value)).toBe(2);
  });

  for (const loseLock of [false, true]) {
    it(`heartbeats re-embed progress (ownership lost: ${loseLock})`, async () => {
      const shard = await createSourceShard();
      await stubEmbedding();
      const { CONFIG } = await import("../src/config.js");
      CONFIG.embeddingDimensions = 4;
      const { TURSO_LOCK_STALE_MS } = await import("../src/services/turso/operation-lock.js");
      const oldTimestamp = new Date(Date.now() - TURSO_LOCK_STALE_MS - 60_000).toISOString();
      const lockPath = join(baseDir, ".turso-operation.lock");
      const { migrationService } = await import("../src/services/migration-service.js");
      const result = await migrationService.migrateToNewModel("re-embed", (progress) => {
        if (progress.phase !== "re-embedding") return;
        if (progress.processed === 1) {
          const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
          writeFileSync(
            lockPath,
            JSON.stringify({
              ...lock,
              id: loseLock ? "foreign-acquisition" : lock.id,
              pid: loseLock ? 2147483647 : process.pid,
              timestamp: oldTimestamp,
            })
          );
        } else if (progress.processed === 2) {
          const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
          expect(Date.parse(lock.timestamp)).toBeGreaterThan(Date.parse(oldTimestamp));
        }
      });
      expect(result.success).toBe(!loseLock);
      if (loseLock) {
        expect(result.error).toContain("ownership lost");
        expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(2147483647);
        const { tursoConnectionManager } =
          await import("../src/services/turso/connection-manager.js");
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const row = await db.get("SELECT vector_extract(vector) AS vector FROM memories LIMIT 1");
        expect(JSON.parse(String(row?.vector))).toHaveLength(2);
      }
    });
  }

  it("preserves a successor re-embed journal after ownership loss", async () => {
    const shard = await createSourceShard();
    await stubEmbedding();
    const { CONFIG } = await import("../src/config.js");
    CONFIG.embeddingDimensions = 4;
    const { TURSO_LOCK_STALE_MS } = await import("../src/services/turso/operation-lock.js");
    const lockPath = join(baseDir, ".turso-operation.lock");
    const statePath = `${shard.dbPath}.reembed-swap.json`;
    const successorJournal = {
      dbPath: shard.dbPath,
      stagedPath: `${shard.dbPath}.reembed-successor.tmp`,
      backupPath: `${shard.dbPath}.pre-reembed-successor.bak`,
      owner: "successor",
    };
    const originalWrite = fs.writeFileSync;
    const write = spyOn(fs, "writeFileSync").mockImplementation(((
      ...args: Parameters<typeof originalWrite>
    ) => {
      originalWrite(...args);
      const target = String(args[0]);
      if (!target.endsWith(".reembed-swap.json")) return;
      originalWrite(statePath, JSON.stringify(successorJournal), "utf-8");
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      originalWrite(
        lockPath,
        JSON.stringify({
          ...lock,
          id: "foreign-acquisition",
          pid: 2147483647,
          timestamp: new Date(Date.now() - TURSO_LOCK_STALE_MS - 60_000).toISOString(),
        })
      );
    }) as typeof originalWrite);

    try {
      const { migrationService } = await import("../src/services/migration-service.js");
      const result = await migrationService.migrateToNewModel("re-embed");
      expect(result.success).toBe(false);
      expect(result.error).toContain("ownership lost");
      expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(successorJournal);
    } finally {
      write.mockRestore();
    }
  });

  it("archives source shards instead of deleting them during fresh start", async () => {
    const shard = await createSourceShard();
    const { CONFIG } = await import("../src/config.js");
    CONFIG.embeddingDimensions = 4;

    const { migrationService } = await import("../src/services/migration-service.js");
    const result = await migrationService.migrateToNewModel("fresh-start");

    expect(result.success).toBe(true);
    expect(result.deletedShards).toBe(1);
    const files = readdirSync(join(baseDir, "projects"));
    expect(files.some((name) => name.includes(".fresh-start-") && name.endsWith(".bak"))).toBe(
      true
    );
    expect(files).not.toContain(shard.dbPath.split("/").at(-1));

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    expect(await tursoShardManager.getAllShards("project", SCOPE_HASH)).toHaveLength(0);
  });

  it("recovers a crash between source backup and replacement rename", async () => {
    const shard = await createSourceShard();
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    await tursoConnectionManager.closeConnection(shard.dbPath);

    const stagedPath = `${shard.dbPath}.reembed-crash.tmp`;
    const backupPath = `${shard.dbPath}.pre-reembed-crash.bak`;
    const statePath = `${shard.dbPath}.reembed-swap.json`;
    const { renameSqliteDatabase } = await import("../src/services/turso/sqlite-handle-release.js");
    // Duplicate current DB as staged replacement, then move original to backup.
    copyFileSync(shard.dbPath, stagedPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${shard.dbPath}${suffix}`)) {
        copyFileSync(`${shard.dbPath}${suffix}`, `${stagedPath}${suffix}`);
      }
    }
    renameSqliteDatabase(shard.dbPath, backupPath);
    writeFileSync(
      statePath,
      JSON.stringify({ dbPath: shard.dbPath, stagedPath, backupPath }),
      "utf-8"
    );

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    expect(existsSync(shard.dbPath)).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const count = await db.get(`SELECT COUNT(*) AS count FROM memories`);
    expect(Number(count?.count)).toBe(2);
  });
});
