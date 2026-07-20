import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("turso dedup vector_extract", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("detects near-duplicates using vector_extract JSON", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-dedup-extract-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 8;
    CONFIG.deduplicationEnabled = true;
    CONFIG.deduplicationSimilarityThreshold = 0.9;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const { deduplicationService } = await import("../src/services/deduplication-service.js");

    const scopeHash = "f1f2f3f4f5f67890";
    const containerTag = `opencode_project_${scopeHash}`;
    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    const vectorA = new Float32Array(8);
    vectorA[0] = 1;
    const vectorB = new Float32Array(8);
    vectorB[0] = 0.99;
    vectorB[1] = 0.1;

    await tursoVectorSearch.insertVector(db, {
      id: "mem_a",
      content: "alpha",
      vector: vectorA,
      containerTag,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await tursoVectorSearch.insertVector(db, {
      id: "mem_b",
      content: "beta",
      vector: vectorB,
      containerTag,
      createdAt: Date.now() + 1,
      updatedAt: Date.now() + 1,
    });

    const extracted = await tursoVectorSearch.getAllMemoriesWithExtractedVectors(db);
    expect(extracted.length).toBe(2);
    expect(typeof extracted[0]?.vector_json).toBe("string");
    expect(String(extracted[0]?.vector_json).length).toBeGreaterThan(2);

    const result = await deduplicationService.detectAndRemoveDuplicates();
    expect(
      result.nearDuplicateGroups.length + result.exactDuplicatesDeleted
    ).toBeGreaterThanOrEqual(0);
    // Near-dup group should be detected when vectors are highly similar
    expect(result.nearDuplicateGroups.length).toBeGreaterThanOrEqual(1);
  });
});
