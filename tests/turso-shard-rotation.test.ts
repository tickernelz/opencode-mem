import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("turso shard rotation", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("marks a full shard read-only and creates the next shard", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-rotation-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 4;
    CONFIG.maxVectorsPerShard = 1;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const hash = "abcdef0123456789";

    const first = await tursoShardManager.getWriteShard("project", hash);
    const db = await tursoConnectionManager.getConnection(first.dbPath);
    await tursoVectorSearch.insertVector(db, {
      id: "mem_rotation_1",
      content: "fills the first shard",
      vector: new Float32Array([1, 0, 0, 0]),
      containerTag: `opencode_project_${hash}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await tursoShardManager.incrementVectorCount(first.id);

    const second = await tursoShardManager.getWriteShard("project", hash);
    expect(second.shardIndex).toBe(1);
    expect(second.id).not.toBe(first.id);

    const all = await tursoShardManager.getAllShards("project", hash);
    expect(all).toHaveLength(2);
    expect(all.find((shard) => shard.id === first.id)?.isActive).toBe(false);
    expect(all.find((shard) => shard.id === second.id)?.isActive).toBe(true);
  });

  it("blocks writes while a migration operation owns the storage lock", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-operation-lock-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 4;
    const { acquireTursoOperationLock } = await import("../src/services/turso/operation-lock.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");

    const release = acquireTursoOperationLock("test");
    await expect(tursoShardManager.getWriteShard("project", "abcdef0123456789")).rejects.toThrow(
      /writes are temporarily blocked/
    );
    release();

    expect((await tursoShardManager.getWriteShard("project", "abcdef0123456789")).shardIndex).toBe(
      0
    );
  });
});
