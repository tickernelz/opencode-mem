import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCOPE_HASH = "0123456789abcdef";

describe("turso re-embed migration safety", () => {
  let baseDir: string;
  let restoreEmbedding: (() => void) | undefined;

  afterEach(async () => {
    restoreEmbedding?.();
    restoreEmbedding = undefined;
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  async function createSourceShard() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-reembed-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 2;

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
    copyFileSync(shard.dbPath, stagedPath);
    renameSync(shard.dbPath, backupPath);
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
