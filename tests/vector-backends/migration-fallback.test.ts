import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase } from "../../src/services/sqlite/sqlite-bootstrap.js";
import { ExactScanBackend } from "../../src/services/vector-backends/exact-scan-backend.js";
import { VectorSearch } from "../../src/services/sqlite/vector-search.js";
import { removeTempDirs } from "../helpers/temp-dir.mjs";
import { connectionManager } from "../../src/services/sqlite/connection-manager.js";

const Database = getDatabase();

describe("migration with backend abstraction", () => {
  const tempDirs: string[] = [];
  const databases: Array<{ close: () => void }> = [];

  afterEach(async () => {
    connectionManager.closeAll();
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    await removeTempDirs(tempDirs);
  });

  it("rebuilds and searches memories without direct hnsw manager calls", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "migration-backend-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = new Database(dbPath);
    databases.push(db);
    db.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT,
        vector BLOB,
        tags_vector BLOB,
        container_tag TEXT,
        tags TEXT,
        type TEXT,
        created_at INTEGER,
        updated_at INTEGER,
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

    db.prepare(
      `INSERT INTO memories (id, content, vector, tags_vector, container_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "a",
      "alpha",
      new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer),
      null,
      "opencode_project_hash",
      Date.now(),
      Date.now()
    );

    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath,
      vectorCount: 1,
      isActive: true,
      createdAt: Date.now(),
    };

    const vectorSearch = new VectorSearch(new ExactScanBackend());

    await expect(
      vectorSearch.rebuildIndexForShard(db, "project", "hash", 0)
    ).resolves.toBeUndefined();

    const results = await vectorSearch.searchInShard(
      shard,
      new Float32Array([1, 0, 0, 0]),
      "opencode_project_hash",
      1,
      "alpha"
    );

    expect(results.map((r) => r.id)).toEqual(["a"]);
  });
});
