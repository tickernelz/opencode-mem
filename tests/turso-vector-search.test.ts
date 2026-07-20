import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("turso vector search", () => {
  it("inserts and searches memories with native vector index", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "turso-vector-test-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const dims = CONFIG.embeddingDimensions;
    const vector = new Float32Array(dims);
    vector[0] = 1;
    const tagsVector = new Float32Array(dims);
    tagsVector[1] = 1;

    const scopeHash = "a1b2c3d4e5f67890";
    const containerTag = `opencode_project_${scopeHash}`;

    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    await tursoVectorSearch.insertVector(db, {
      id: "mem_test_1",
      content: "Turso native vector search",
      vector,
      tagsVector,
      containerTag,
      tags: "turso,vector",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await tursoVectorSearch.insertVector(db, {
      id: "mem_test_no_tags",
      content: "Content only vector",
      vector,
      containerTag,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const results = await tursoVectorSearch.searchInShard(shard, vector, containerTag, 5, "turso");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("mem_test_1");
    expect(results[0]?.similarity).toBeGreaterThan(0.5);

    const limitedResults = await tursoVectorSearch.searchInShard(
      shard,
      vector,
      containerTag,
      1,
      "turso"
    );
    expect(limitedResults).toHaveLength(1);

    await tursoConnectionManager.closeAll();
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    rmSync(baseDir, { recursive: true, force: true });
  });
});
