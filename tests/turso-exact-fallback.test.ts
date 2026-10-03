import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso exact cosine search", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("finds memories via exact cosine scan without vector indexes", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-exact-scan-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 8;

    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/storage/turso/shard-manager.js");
    const { tursoVectorSearch } = await import("../src/storage/turso/vector-search.js");

    const scopeHash = "e1e2e3e4e5f67890";
    const containerTag = `opencode_project_${scopeHash}`;
    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    const vector = new Float32Array(8);
    vector[0] = 1;
    await tursoVectorSearch.insertVector(db, {
      id: "mem_exact_1",
      content: "exact cosine memory",
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
