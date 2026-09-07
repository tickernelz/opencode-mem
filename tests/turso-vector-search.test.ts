import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso vector search", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("inserts and searches memories with native vector index", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-vector-test-"));

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

    const indexDefinitions = await db.all<{ name: string; sql: string }>(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE type = 'index' AND name IN ('memories_vec_idx', 'memories_tags_vec_idx')
    `);
    expect(indexDefinitions).toHaveLength(2);
    for (const index of indexDefinitions) {
      expect(index.sql).toContain("'metric=cosine'");
      expect(index.sql).toContain("'compress_neighbors=float8'");
      expect(index.sql).toContain("'max_neighbors=20'");
    }

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

    const contentIndexHit = await db.get<{ id: string }>(
      `
        SELECT m.id AS id
        FROM vector_top_k('memories_vec_idx', vector32(?), 1) AS v
        CROSS JOIN memories m ON m.rowid = v.id
      `,
      [JSON.stringify(Array.from(vector))]
    );
    const tagsIndexHit = await db.get<{ id: string }>(
      `
        SELECT m.id AS id
        FROM vector_top_k('memories_tags_vec_idx', vector32(?), 1) AS v
        CROSS JOIN memories m ON m.rowid = v.id
      `,
      [JSON.stringify(Array.from(tagsVector))]
    );
    expect(contentIndexHit?.id).toBe("mem_test_1");
    expect(tagsIndexHit?.id).toBe("mem_test_1");

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
  });

  it("keeps vector_top_k before memories for filtered and unfiltered ANN queries", async () => {
    const observedSql: string[] = [];
    const db = {
      all: async (sql: string) => {
        observedSql.push(sql);
        return [];
      },
    };
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const search = tursoVectorSearch as unknown as {
      searchKind(
        database: typeof db,
        queryJson: string,
        k: number,
        containerTag: string,
        indexName: string,
        columnName: string
      ): Promise<Array<{ id: string; similarity: number }>>;
    };

    await search.searchKind(db, "[1,0]", 10, "", "memories_vec_idx", "vector");
    await search.searchKind(db, "[1,0]", 10, "opencode_project_test", "memories_vec_idx", "vector");

    expect(observedSql).toHaveLength(2);
    for (const sql of observedSql) {
      expect(sql).toContain("FROM vector_top_k");
      expect(sql).toContain("CROSS JOIN memories m ON m.rowid = v.id");
      expect(sql.indexOf("vector_top_k")).toBeLessThan(sql.indexOf("memories m"));
    }
    expect(observedSql[1]).toContain("m.container_tag = ?");
  });

  // Seeding 200 vectors plus a real ANN search can exceed bun's default 5s test
  // timeout on slower CI runners (observed on windows-latest), so give this
  // integration-style check explicit headroom. The assertions are unchanged.
  it("returns correct tagged memories from ANN above the k threshold (result-level plan check)", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-vector-ann-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const dims = CONFIG.embeddingDimensions;
    const scopeHash = "a1b2c3d4e5f67890";
    const targetTag = `opencode_project_${scopeHash}`;
    const otherTag = "opencode_project_0000000000000000";

    const shard = await tursoShardManager.createShard("project", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);

    // Insert 200 memories across two container tags, well above the k=128
    // threshold for container-tagged ANN searches. The target-tag memory at
    // index 0 has the query vector itself (similarity 1.0), so it must rank
    // first; other-tag memories must never appear in results.
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      const vec = new Float32Array(dims);
      // Spread signal across dimensions so vectors are distinguishable but
      // the index-0 vector is closest to the query (also vec[0]=1).
      vec[i % dims] = 1;
      if (i > 0) vec[0] = 0.001;

      const tag = i < 150 ? targetTag : otherTag;
      await tursoVectorSearch.insertVector(db, {
        id: `mem_ann_${i}`,
        content: `Memory ${i}`,
        vector: vec,
        containerTag: tag,
        tags: "",
        createdAt: now - (200 - i),
        updatedAt: now,
      });
    }

    // Query vector matches mem_ann_0 (vec[0]=1, no other dimensions set).
    const queryVector = new Float32Array(dims);
    queryVector[0] = 1;

    const results = await tursoVectorSearch.searchInShard(
      shard,
      queryVector,
      targetTag,
      10,
      "turso"
    );

    expect(results.length).toBeGreaterThan(0);
    // The closest target-tag memory must rank first.
    expect(results[0]?.id).toBe("mem_ann_0");
    expect(results[0]?.similarity).toBeGreaterThan(0.9);
    // No other-container-tag memories (indices 150-199) should leak through.
    for (const r of results) {
      const idx = Number(r.id.replace("mem_ann_", ""));
      expect(idx).toBeLessThan(150);
    }
    // Results should be limited to the requested limit.
    expect(results.length).toBeLessThanOrEqual(10);
  }, 60000);
});
