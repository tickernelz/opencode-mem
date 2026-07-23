import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("turso exact scan fallback", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("falls back to exact scan when vector_top_k index is missing", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-exact-fallback-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 8;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const scopeHash = "e1e2e3e4e5f67890";
    const containerTag = `opencode_project_${scopeHash}`;
    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    await db.run(`DROP INDEX IF EXISTS memories_vec_idx`);
    await db.run(`DROP INDEX IF EXISTS memories_tags_vec_idx`);

    const vector = new Float32Array(8);
    vector[0] = 1;
    await tursoVectorSearch.insertVector(db, {
      id: "mem_exact_1",
      content: "exact fallback memory",
      vector,
      containerTag,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const results = await tursoVectorSearch.searchInShard(shard, vector, containerTag, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("mem_exact_1");
  });
});
