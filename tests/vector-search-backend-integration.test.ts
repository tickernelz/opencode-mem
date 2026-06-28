import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExactScanBackend } from "../src/services/vector-backends/exact-scan-backend.js";
import { getDatabase } from "../src/services/sqlite/sqlite-bootstrap.js";
import { VectorSearch } from "../src/services/sqlite/vector-search.js";
import type { VectorBackend } from "../src/services/vector-backends/types.js";
import { removeTempDirs } from "./helpers/temp-dir.mjs";
import { connectionManager } from "../src/services/sqlite/connection-manager.js";

const Database = getDatabase();

function createFailingBackend(): VectorBackend {
  return {
    getBackendName: () => "usearch",
    insert: async () => {},
    insertBatch: async () => {},
    delete: async () => {},
    search: async () => {
      throw new Error("forced-search-failure");
    },
    rebuildFromShard: async () => {
      throw new Error("forced-rebuild-failure");
    },
    deleteShardIndexes: async () => {},
  };
}

describe("vector search backend integration", () => {
  const tempDirs: string[] = [];
  const databases: Array<{ close: () => void }> = [];

  afterEach(async () => {
    connectionManager.closeAll();
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    await removeTempDirs(tempDirs);
  });

  it("searches inserted memories and preserves ranking semantics", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vector-search-integration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = new Database(dbPath);
    databases.push(db);

    db.run(`
      CREATE TABLE memories (
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
      )
    `);

    const vectorSearch = new VectorSearch(new ExactScanBackend());
    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath,
      vectorCount: 2,
      isActive: true,
      createdAt: Date.now(),
    };

    await vectorSearch.insertVector(
      db,
      {
        id: "b",
        content: "beta memory",
        vector: new Float32Array([0, 1, 0, 0]),
        tagsVector: new Float32Array([0, 1, 0, 0]),
        containerTag: "opencode_project_hash",
        tags: "beta",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      shard
    );

    await vectorSearch.insertVector(
      db,
      {
        id: "a",
        content: "alpha memory",
        vector: new Float32Array([1, 0, 0, 0]),
        tagsVector: new Float32Array([1, 0, 0, 0]),
        containerTag: "opencode_project_hash",
        tags: "alpha,priority",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      shard
    );

    const results = await vectorSearch.searchInShard(
      shard,
      new Float32Array([1, 0, 0, 0]),
      "opencode_project_hash",
      2,
      "alpha"
    );

    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(results[0]?.similarity).toBeGreaterThan(results[1]?.similarity ?? 0);
    expect(typeof results[0]?.similarity).toBe("number");
    expect(typeof results[1]?.similarity).toBe("number");
  });

  it("falls back to exact scan when the preferred backend fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vector-search-fallback-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = new Database(dbPath);
    databases.push(db);

    db.run(`
      CREATE TABLE memories (
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
      )
    `);

    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath,
      vectorCount: 2,
      isActive: true,
      createdAt: Date.now(),
    };

    const vectorSearch = new VectorSearch(createFailingBackend(), new ExactScanBackend());

    db.prepare(
      `INSERT INTO memories (id, content, vector, tags_vector, container_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "a",
      "alpha memory",
      new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer),
      new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer),
      "opencode_project_hash",
      Date.now(),
      Date.now()
    );
    db.prepare(
      `INSERT INTO memories (id, content, vector, tags_vector, container_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "b",
      "beta memory",
      new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer),
      new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer),
      "opencode_project_hash",
      Date.now(),
      Date.now()
    );

    const results = await vectorSearch.searchInShard(
      shard,
      new Float32Array([1, 0, 0, 0]),
      "opencode_project_hash",
      2,
      "alpha"
    );

    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(typeof results[0]?.similarity).toBe("number");
  });
});
