import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase } from "../../src/services/sqlite/sqlite-bootstrap.js";
import { USearchBackend } from "../../src/services/vector-backends/usearch-backend.js";
import { removeTempDirs } from "../helpers/temp-dir.mjs";

const Database = getDatabase();
const canLoadUSearch = await import("usearch").then(() => true).catch(() => false);
const itIfUSearchAvailable = canLoadUSearch ? it : it.skip;

describe("USearchBackend", () => {
  const tempDirs: string[] = [];
  const databases: Array<{ close: () => void }> = [];

  afterEach(async () => {
    while (databases.length > 0) {
      databases.pop()?.close();
    }
    await removeTempDirs(tempDirs);
  });

  itIfUSearchAvailable("creates and searches an in-memory index", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-"));
    tempDirs.push(baseDir);

    const backend = new USearchBackend({ baseDir, dimensions: 4 });

    await backend.insertManyForTest("project_hash_0_content", [
      { id: "a", vector: new Float32Array([1, 0, 0, 0]) },
      { id: "b", vector: new Float32Array([0, 1, 0, 0]) },
      { id: "c", vector: new Float32Array([0.9, 0.1, 0, 0]) },
    ]);

    const result = await backend.searchForTest(
      "project_hash_0_content",
      new Float32Array([1, 0, 0, 0]),
      2
    );

    expect(result.map((x) => x.id)).toEqual(["a", "c"]);
  });

  itIfUSearchAvailable("supports public insert and search path", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-public-"));
    tempDirs.push(baseDir);

    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath: join(baseDir, "test.db"),
      vectorCount: 1,
      isActive: true,
      createdAt: Date.now(),
    };

    const backend = new USearchBackend({ baseDir, dimensions: 4 });
    await backend.insert({
      id: "alpha",
      vector: new Float32Array([1, 0, 0, 0]),
      shard,
      kind: "content",
    });

    const result = await backend.search({
      db: null,
      shard,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 1,
    });

    expect(result.map((x) => x.id)).toEqual(["alpha"]);
  });

  itIfUSearchAvailable(
    "updates an existing id instead of failing on duplicate insert",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-upsert-"));
      tempDirs.push(baseDir);

      const shard = {
        id: 1,
        scope: "project" as const,
        scopeHash: "hash",
        shardIndex: 0,
        dbPath: join(baseDir, "test.db"),
        vectorCount: 1,
        isActive: true,
        createdAt: Date.now(),
      };

      const backend = new USearchBackend({ baseDir, dimensions: 4 });
      await backend.insert({
        id: "alpha",
        vector: new Float32Array([0, 1, 0, 0]),
        shard,
        kind: "content",
      });
      await backend.insert({
        id: "alpha",
        vector: new Float32Array([1, 0, 0, 0]),
        shard,
        kind: "content",
      });

      const result = await backend.search({
        db: null,
        shard,
        kind: "content",
        queryVector: new Float32Array([1, 0, 0, 0]),
        limit: 1,
      });

      expect(result.map((x) => x.id)).toEqual(["alpha"]);
    }
  );

  itIfUSearchAvailable("rebuilds an index from sqlite rows", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "usearch-backend-rebuild-"));
    tempDirs.push(baseDir);
    const db = new Database(join(baseDir, "test.db"));
    databases.push(db);
    db.run(`CREATE TABLE memories (id TEXT PRIMARY KEY, vector BLOB, tags_vector BLOB)`);
    db.prepare(`INSERT INTO memories (id, vector, tags_vector) VALUES (?, ?, ?)`).run(
      "alpha",
      new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer),
      null
    );

    const shard = {
      id: 1,
      scope: "project" as const,
      scopeHash: "hash",
      shardIndex: 0,
      dbPath: join(baseDir, "test.db"),
      vectorCount: 1,
      isActive: true,
      createdAt: Date.now(),
    };

    const backend = new USearchBackend({ baseDir, dimensions: 4 });
    await backend.rebuildFromShard({ db, shard, kind: "content" });

    const result = await backend.search({
      db,
      shard,
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 1,
    });

    expect(result.map((x) => x.id)).toEqual(["alpha"]);
  });
});
