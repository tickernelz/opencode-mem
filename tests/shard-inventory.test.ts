import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("shard inventory and source resolution", () => {
  let baseDir: string;
  let oldProjectDir: string;
  let newProjectDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  async function setup() {
    baseDir = mkdtempSync(join(tmpdir(), "shard-inventory-"));
    oldProjectDir = join(baseDir, "old-project");
    newProjectDir = join(baseDir, "new-project");
    mkdirSync(oldProjectDir, { recursive: true });
    mkdirSync(newProjectDir, { recursive: true });

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = join(baseDir, "storage");
    CONFIG.embeddingDimensions = 2;
    CONFIG.containerTagPrefix = "opencode";

    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const oldTag = getProjectTagInfo(oldProjectDir);
    const oldHash = oldTag.tag.split("_").pop()!;
    const shard = await tursoShardManager.createShard("project", oldHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoVectorSearch.insertVector(db, {
      id: "mem_old_1",
      content: "legacy architecture note",
      vector: new Float32Array([1, 0]),
      containerTag: oldTag.tag,
      type: "project",
      createdAt: 100,
      updatedAt: 100,
      projectPath: oldProjectDir,
      projectName: oldTag.projectName,
      displayName: oldTag.displayName,
    });
    await tursoShardManager.incrementVectorCount(shard.id);

    return { oldTag, oldHash, getProjectTagInfo };
  }

  it("lists orphaned shards when the stored project path is gone", async () => {
    const { oldHash } = await setup();
    const { rmSync } = await import("node:fs");
    rmSync(oldProjectDir, { recursive: true, force: true });

    const { shardInventoryService } = await import("../src/services/shard-inventory-service.js");
    const result = await shardInventoryService.listShards(newProjectDir);

    expect(result.success).toBe(true);
    const orphan = result.shards.find((shard) => shard.scopeHash === oldHash);
    expect(orphan).toBeDefined();
    expect(orphan!.status).toBe("orphaned");
    expect(orphan!.memoryCount).toBe(1);
    expect(orphan!.pathExists).toBe(false);
  });

  it("resolves migration source by stored project path and by fromHash", async () => {
    const { oldHash } = await setup();
    const { shardInventoryService } = await import("../src/services/shard-inventory-service.js");

    const byPath = await shardInventoryService.resolveMigrationSource(newProjectDir, {
      fromPath: oldProjectDir,
    });
    expect(byPath.success).toBe(true);
    expect(byPath.source?.matchedBy).toBe("storedProjectPath");
    expect(byPath.source?.scopeHash).toBe(oldHash);

    // Stored project_path matching still works after the directory is deleted.
    const { rmSync } = await import("node:fs");
    rmSync(oldProjectDir, { recursive: true, force: true });

    const byStoredPathAfterDelete = await shardInventoryService.resolveMigrationSource(
      newProjectDir,
      { fromPath: oldProjectDir }
    );
    expect(byStoredPathAfterDelete.success).toBe(true);
    expect(byStoredPathAfterDelete.source?.matchedBy).toBe("storedProjectPath");

    const byHash = await shardInventoryService.resolveMigrationSource(newProjectDir, {
      fromHash: oldHash,
    });
    expect(byHash.success).toBe(true);
    expect(byHash.source?.matchedBy).toBe("fromHash");
    expect(byHash.source?.scopeHash).toBe(oldHash);

    const missing = await shardInventoryService.resolveMigrationSource(newProjectDir, {
      fromPath: join(baseDir, "never-existed-project"),
    });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("fromHash");
  });

  it("rejects ambiguous and invalid fromHash values", async () => {
    await setup();
    const { shardInventoryService } = await import("../src/services/shard-inventory-service.js");

    const invalid = await shardInventoryService.resolveMigrationSource(newProjectDir, {
      fromHash: "not-a-hash",
    });
    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain("Invalid fromHash");

    const unknown = await shardInventoryService.resolveMigrationSource(newProjectDir, {
      fromHash: "0123456789abcdef",
    });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain("No project shards found");
  });
});
