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

  it("inserts and searches memories with exact cosine distance", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-vector-test-"));

    const { CONFIG } = await import("../src/config.js");
    const previousStoragePath = CONFIG.storagePath;
    CONFIG.storagePath = baseDir;

    try {
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
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

      const diskAnnIndexes = await db.all<{ name: string }>(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'index' AND name IN ('memories_vec_idx', 'memories_tags_vec_idx')
    `);
      expect(diskAnnIndexes).toHaveLength(0);

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

      const contentHit = await db.get<{ id: string }>(
        `
        SELECT m.id AS id
        FROM memories m
        WHERE m.vector IS NOT NULL
        ORDER BY vector_distance_cos(m.vector, vector32(?)) ASC
        LIMIT 1
      `,
        [JSON.stringify(Array.from(vector))]
      );
      const tagsHit = await db.get<{ id: string }>(
        `
        SELECT m.id AS id
        FROM memories m
        WHERE m.tags_vector IS NOT NULL
        ORDER BY vector_distance_cos(m.tags_vector, vector32(?)) ASC
        LIMIT 1
      `,
        [JSON.stringify(Array.from(tagsVector))]
      );
      expect(contentHit?.id).toBe("mem_test_1");
      expect(tagsHit?.id).toBe("mem_test_1");

      await tursoVectorSearch.insertVector(db, {
        id: "mem_test_no_tags",
        content: "Content only vector",
        vector,
        containerTag,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const results = await tursoVectorSearch.searchInShard(
        shard,
        vector,
        containerTag,
        5,
        "turso"
      );

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
    } finally {
      CONFIG.storagePath = previousStoragePath;
    }
  });

  it("uses exact cosine scans for filtered and unfiltered queries", async () => {
    const observedSql: string[] = [];
    const db = {
      all: async (sql: string) => {
        observedSql.push(sql);
        return [];
      },
    };
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const search = tursoVectorSearch as unknown as {
      exactScanKind(
        database: typeof db,
        queryJson: string,
        k: number,
        containerTag: string,
        columnName: string
      ): Promise<Array<{ id: string; similarity: number }>>;
    };

    await search.exactScanKind(db, "[1,0]", 10, "", "vector");
    await search.exactScanKind(db, "[1,0]", 10, "opencode_project_test", "vector");

    expect(observedSql).toHaveLength(2);
    for (const sql of observedSql) {
      expect(sql).toContain("vector_distance_cos");
      expect(sql).toContain("FROM memories m");
      expect(sql).not.toContain("vector_top_k");
    }
    expect(observedSql[1]).toContain("m.container_tag = ?");
  });

  // Large exact-scan + container_tag filter. Explicit timeout for slower CI runners.
  it("ranks exact cosine hits and filters other container tags", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-vector-rank-"));

    const { CONFIG } = await import("../src/config.js");
    const previousStoragePath = CONFIG.storagePath;
    CONFIG.storagePath = baseDir;

    try {
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

      const dims = CONFIG.embeddingDimensions;
      const scopeHash = "a1b2c3d4e5f67890";
      const targetTag = `opencode_project_${scopeHash}`;
      const otherTag = "opencode_project_0000000000000000";

      const shard = await tursoShardManager.createShard("project", scopeHash, 0);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);

      // 200 memories across two tags. mem_rank_0 is an exact query match;
      // every other vector is orthogonal on a different dim.
      const now = Date.now();
      for (let i = 0; i < 200; i++) {
        const vec = new Float32Array(dims);
        if (i === 0) {
          vec[0] = 1;
        } else {
          vec[i % dims === 0 ? 1 : i % dims] = 1;
        }

        const tag = i < 150 ? targetTag : otherTag;
        await tursoVectorSearch.insertVector(db, {
          id: `mem_rank_${i}`,
          content: `Memory ${i}`,
          vector: vec,
          containerTag: tag,
          tags: "",
          createdAt: now - (200 - i),
          updatedAt: now,
        });
      }

      const queryVector = new Float32Array(dims);
      queryVector[0] = 1;

      // No queryText: avoids keyword boost; ranking is pure vector similarity.
      const results = await tursoVectorSearch.searchInShard(shard, queryVector, targetTag, 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe("mem_rank_0");
      // Hybrid score is 0.6*content + 0.4*tags; tags_vector is null → ~0.6 for exact hit.
      expect(results[0]?.similarity).toBeGreaterThan(0.55);
      for (const r of results) {
        const idx = Number(r.id.replace("mem_rank_", ""));
        expect(idx).toBeLessThan(150);
      }
      expect(results.length).toBeLessThanOrEqual(10);
    } finally {
      CONFIG.storagePath = previousStoragePath;
    }
  }, 60000);

  it("boosts keyword matches in hybrid ranking and indexes session_id", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-hybrid-session-"));

    const { CONFIG } = await import("../src/config.js");
    const previousStoragePath = CONFIG.storagePath;
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 8;

    try {
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

      const scopeHash = "b2c3d4e5f6789012";
      const containerTag = `opencode_project_${scopeHash}`;
      const shard = await tursoShardManager.createShard("project", scopeHash, 0);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);

      const queryVector = new Float32Array(8);
      queryVector[0] = 1;
      const orthogonal = new Float32Array(8);
      orthogonal[1] = 1;

      await tursoVectorSearch.insertVector(db, {
        id: "mem_kw",
        content: "unique-keyword-alpha appears here",
        vector: orthogonal,
        containerTag,
        sessionId: "sess_hybrid_1",
        metadata: JSON.stringify({ sessionID: "sess_hybrid_1" }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await tursoVectorSearch.insertVector(db, {
        id: "mem_vec",
        content: "unrelated text",
        vector: queryVector,
        containerTag,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const bySession = await tursoVectorSearch.getMemoriesBySessionID(db, "sess_hybrid_1");
      expect(bySession.map((row) => String(row.id))).toContain("mem_kw");

      const sessionRow = await db.get<{ session_id: string }>(
        `SELECT session_id FROM memories WHERE id = ?`,
        ["mem_kw"]
      );
      expect(sessionRow?.session_id).toBe("sess_hybrid_1");

      const hybrid = await tursoVectorSearch.searchInShard(
        shard,
        queryVector,
        containerTag,
        5,
        "unique-keyword-alpha"
      );
      expect(hybrid.some((r) => r.id === "mem_kw")).toBe(true);
      const keywordHit = hybrid.find((r) => r.id === "mem_kw");
      const vectorHit = hybrid.find((r) => r.id === "mem_vec");
      expect(keywordHit).toBeTruthy();
      expect(vectorHit).toBeTruthy();
      // Keyword hybrid weight should keep the text match competitive.
      expect(keywordHit!.similarity).toBeGreaterThan(0.1);
    } finally {
      CONFIG.storagePath = previousStoragePath;
    }
  });

  it("does not penalize semantic vector similarity when natural-language queryText has no LIKE keyword hits", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-semantic-no-kw-"));

    const { CONFIG } = await import("../src/config.js");
    const previousStoragePath = CONFIG.storagePath;
    const previousDims = CONFIG.embeddingDimensions;
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 8;

    try {
      const { tursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");
      const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
      const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

      const scopeHash = "c3d4e5f678901234";
      const containerTag = `opencode_project_${scopeHash}`;
      const shard = await tursoShardManager.createShard("project", scopeHash, 0);
      const db = await tursoConnectionManager.getConnection(shard.dbPath);

      const queryVector = new Float32Array(8);
      queryVector[0] = 1;
      const contentVector = new Float32Array(8);
      contentVector[0] = 0.8;
      contentVector[1] = 0.6;
      const tagsVector = new Float32Array(8);
      tagsVector[0] = 0.35;
      tagsVector[1] = Math.sqrt(1 - 0.35 * 0.35);

      await tursoVectorSearch.insertVector(db, {
        id: "mem_semantic_cjk",
        content: "自动捕获在内部会话和子会话中会被跳过",
        vector: contentVector,
        tagsVector,
        tags: "capture,skip",
        containerTag,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const webSearchResults = await tursoVectorSearch.searchInShard(
        shard,
        queryVector,
        containerTag,
        5
      );
      expect(webSearchResults).toHaveLength(1);
      // 0.6 * 0.8 + 0.4 * 0.35 = 0.62 (>= 0.60 default threshold)
      expect(webSearchResults[0]!.similarity).toBeCloseTo(0.62, 2);

      // Automatic recall passes the full user prompt as queryText. Even when
      // unsegmented CJK clauses have 0 SQL LIKE hits, semantic similarity must
      // not drop by 20% below the 0.60 threshold (0.5*0.8 + 0.3*0.35 = 0.505).
      const recallResults = await tursoVectorSearch.searchAcrossShards(
        [shard],
        queryVector,
        containerTag,
        5,
        0.6,
        "目前跳过捕获的原因是否正常"
      );
      expect(recallResults.results).toHaveLength(1);
      expect(recallResults.results[0]?.id).toBe("mem_semantic_cjk");
      expect(recallResults.results[0]!.similarity).toBeCloseTo(webSearchResults[0]!.similarity, 4);
    } finally {
      CONFIG.storagePath = previousStoragePath;
      CONFIG.embeddingDimensions = previousDims;
    }
  });
});
