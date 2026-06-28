import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase } from "../../src/services/sqlite/sqlite-bootstrap.js";
import { ExactScanBackend } from "../../src/services/vector-backends/exact-scan-backend.js";
import { removeTempDirs } from "../helpers/temp-dir.mjs";

const Database = getDatabase();

describe("ExactScanBackend", () => {
  const tempDirs: string[] = [];
  const databases: Array<{ close: () => void }> = [];

  afterEach(async () => {
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    await removeTempDirs(tempDirs);
  });

  it("returns nearest vectors in similarity order", () => {
    const backend = new ExactScanBackend();

    const rows = [
      { id: "a", vector: new Float32Array([1, 0, 0, 0]) },
      { id: "b", vector: new Float32Array([0, 1, 0, 0]) },
      { id: "c", vector: new Float32Array([0.9, 0.1, 0, 0]) },
    ];

    const result = backend.rankVectors(rows, new Float32Array([1, 0, 0, 0]), 2);

    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("returns empty result for empty rows", () => {
    const backend = new ExactScanBackend();
    const result = backend.rankVectors([], new Float32Array([1, 0, 0, 0]), 5);
    expect(result).toEqual([]);
  });

  it("searches vectors from sqlite blobs in similarity order", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "exact-scan-backend-"));
    tempDirs.push(tempDir);
    const db = new Database(join(tempDir, "test.db"));
    databases.push(db);

    db.run(`CREATE TABLE memories (id TEXT PRIMARY KEY, vector BLOB, tags_vector BLOB)`);

    const insert = db.prepare(`INSERT INTO memories (id, vector, tags_vector) VALUES (?, ?, ?)`);
    insert.run("a", new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer), null);
    insert.run("b", new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer), null);
    insert.run("c", new Uint8Array(new Float32Array([0.9, 0.1, 0, 0]).buffer), null);

    const backend = new ExactScanBackend();
    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath: join(tempDir, "test.db"),
      vectorCount: 3,
      isActive: true,
      createdAt: Date.now(),
    };

    const result = await backend.search({
      db,
      shard,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 2,
    });

    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("returns empty search result when sqlite has no vectors", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "exact-scan-backend-empty-"));
    tempDirs.push(tempDir);
    const db = new Database(join(tempDir, "test.db"));
    databases.push(db);
    db.run(`CREATE TABLE memories (id TEXT PRIMARY KEY, vector BLOB, tags_vector BLOB)`);

    const backend = new ExactScanBackend();
    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath: join(tempDir, "test.db"),
      vectorCount: 0,
      isActive: true,
      createdAt: Date.now(),
    };

    const result = await backend.search({
      db,
      shard,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 2,
    });

    expect(result).toEqual([]);
  });
});
