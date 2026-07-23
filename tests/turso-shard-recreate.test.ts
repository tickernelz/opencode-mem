import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_SCOPE_HASH = "a1b2c3d4e5f67890";

describe("turso invalid shard protection", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects writes on dimension mismatch without moving or emptying the shard", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-shard-protect-dims-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const shard = await tursoShardManager.createShard("project", TEST_SCOPE_HASH, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const vector = new Float32Array(768);
    vector[0] = 1;
    await tursoVectorSearch.insertVector(db, {
      id: "mem_protected_1",
      content: "must remain available for migration",
      vector,
      containerTag: `opencode_project_${TEST_SCOPE_HASH}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.run(
      `INSERT OR REPLACE INTO shard_metadata (key, value) VALUES ('embedding_dimensions', ?)`,
      ["384"]
    );

    await expect(tursoShardManager.getWriteShard("project", TEST_SCOPE_HASH)).rejects.toThrow(
      /left untouched/
    );

    expect(existsSync(shard.dbPath)).toBe(true);
    expect(existsSync(`${shard.dbPath}.invalid.bak`)).toBe(false);
    const count = await db.get(`SELECT COUNT(*) AS count FROM memories`);
    expect(Number(count?.count)).toBe(1);
  });

  it("rejects writes when dimension metadata is missing without deleting data", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-shard-protect-meta-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const shard = await tursoShardManager.createShard("project", TEST_SCOPE_HASH, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const vector = new Float32Array(768);
    vector[0] = 1;
    await tursoVectorSearch.insertVector(db, {
      id: "mem_missing_meta_1",
      content: "must not be quarantined",
      vector,
      containerTag: `opencode_project_${TEST_SCOPE_HASH}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.run(`DELETE FROM shard_metadata WHERE key = 'embedding_dimensions'`);

    await expect(tursoShardManager.getWriteShard("project", TEST_SCOPE_HASH)).rejects.toThrow(
      /left untouched/
    );

    expect(existsSync(shard.dbPath)).toBe(true);
    const count = await db.get(`SELECT COUNT(*) AS count FROM memories`);
    expect(Number(count?.count)).toBe(1);
  });
});
