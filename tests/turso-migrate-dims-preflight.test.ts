import { describe, expect, it, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@libsql/client";

describe("turso legacy migrator dimension preflight", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("preserves legacy dimensions so startup can expose the re-embed migration", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-migrate-dim-preflight-"));
    const projectsDir = join(baseDir, "projects");
    mkdirSync(projectsDir, { recursive: true });

    const scopeHash = "0011223344556677";
    const dbPath = join(projectsDir, `project_${scopeHash}_shard_0.db`);
    const client = createClient({ url: `file:${dbPath}` });
    await client.batch(
      [
        `CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          vector BLOB NOT NULL,
          container_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      ],
      "write"
    );

    const wrongDims = new Float32Array(4);
    wrongDims[0] = 1;
    await client.execute({
      sql: `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "mem_wrong_dims",
        "wrong dims",
        new Uint8Array(wrongDims.buffer),
        "opencode_project_dimpreflight",
        Date.now(),
        Date.now(),
      ],
    });
    await client.close();

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}.legacy.bak`)).toBe(true);
    expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(true);

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const migratedDb = await tursoConnectionManager.getConnection(dbPath);
    const dimensions = await migratedDb.get(
      `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
    );
    expect(Number(dimensions?.value)).toBe(4);

    const count = await migratedDb.get(`SELECT COUNT(*) AS count FROM memories`);
    expect(Number(count?.count)).toBe(1);

    const { migrationService } = await import("../src/services/migration-service.js");
    const mismatch = await migrationService.detectDimensionMismatch();
    expect(mismatch.needsMigration).toBe(true);
    expect(mismatch.shardMismatches).toHaveLength(1);
    expect(mismatch.shardMismatches[0]?.storedDimensions).toBe(4);
  });
});
