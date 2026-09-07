import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("memory export/import portability", () => {
  let baseDir: string;
  let projectDir: string;
  let restoreEmbedding: (() => void) | undefined;

  afterEach(async () => {
    restoreEmbedding?.();
    restoreEmbedding = undefined;
    await cleanupTursoTestDirectory(baseDir);
  });

  async function stubEmbedding() {
    const { embeddingService } = await import("../src/services/embedding.js");
    const service = embeddingService as any;
    const original = {
      warmup: service.warmup,
      clearCache: service.clearCache,
      embedWithTimeout: service.embedWithTimeout,
      isWarmedUp: service.isWarmedUp,
    };
    service.warmup = async () => {
      service.isWarmedUp = true;
    };
    service.clearCache = () => {};
    service.embedWithTimeout = async () => new Float32Array([1, 0]);
    restoreEmbedding = () => Object.assign(service, original);
  }

  async function setupProject() {
    baseDir = mkdtempSync(join(tmpdir(), "memory-portability-"));
    projectDir = join(baseDir, "project");
    mkdirSync(projectDir, { recursive: true });

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = join(baseDir, "storage");
    CONFIG.embeddingDimensions = 2;
    CONFIG.containerTagPrefix = "opencode";

    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");

    const tag = getProjectTagInfo(projectDir);
    const hash = tag.tag.split("_").pop()!;
    const shard = await tursoShardManager.createShard("project", hash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoVectorSearch.insertVector(db, {
      id: "mem_portable",
      content: "portable architecture decision",
      vector: new Float32Array([1, 0]),
      tagsVector: new Float32Array([0, 1]),
      containerTag: tag.tag,
      tags: "alpha,beta",
      type: "project",
      createdAt: 111,
      updatedAt: 222,
      metadata: JSON.stringify({ source: "test", keep: true }),
      displayName: tag.displayName,
      projectPath: tag.projectPath,
      projectName: tag.projectName,
    });
    await tursoVectorSearch.pinMemory(db, "mem_portable");
    await tursoShardManager.incrementVectorCount(shard.id);
    return { tag, hash };
  }

  it("exports a versioned document and imports with field preservation", async () => {
    await stubEmbedding();
    const { tag } = await setupProject();
    const outputPath = join(baseDir, "memories.json");

    const { memoryPortabilityService } =
      await import("../src/services/memory-portability-service.js");
    const exported = await memoryPortabilityService.exportMemories({
      currentDirectory: projectDir,
      outputPath,
    });
    expect(exported.success).toBe(true);
    expect(existsSync(outputPath)).toBe(true);

    const document = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(document.schemaVersion).toBe(1);
    expect(document.memories).toHaveLength(1);
    expect(document.memories[0].id).toBe("mem_portable");
    expect(document.memories[0].tags).toEqual(["alpha", "beta"]);
    expect(document.memories[0].isPinned).toBe(true);
    expect(document.memories[0].createdAt).toBe(111);
    expect(document.source.containerTag).toBe(tag.tag);
    expect(document.memories[0].vector).toBeUndefined();

    // Import into a fresh empty project directory/hash.
    const otherDir = join(baseDir, "other-project");
    mkdirSync(otherDir, { recursive: true });
    const importResult = await memoryPortabilityService.importMemories({
      currentDirectory: otherDir,
      inputPath: outputPath,
    });
    expect(importResult.success).toBe(true);
    expect(importResult.imported).toBe(1);

    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const otherTag = getProjectTagInfo(otherDir);
    const otherHash = otherTag.tag.split("_").pop()!;
    const shards = await tursoShardManager.getAllShards("project", otherHash);
    expect(shards.length).toBeGreaterThanOrEqual(1);
    const db = await tursoConnectionManager.getConnection(shards[0]!.dbPath);
    const row = await tursoVectorSearch.getMemoryById(db, "mem_portable");
    expect(row).toBeTruthy();
    expect(String(row!.container_tag)).toBe(otherTag.tag);
    expect(String(row!.project_path)).toBe(otherTag.projectPath);
    expect(String(row!.tags)).toBe("alpha,beta");
    expect(Number(row!.created_at)).toBe(111);
    expect(Number(row!.is_pinned)).toBe(1);
    const metadata = JSON.parse(String(row!.metadata));
    expect(metadata.source).toBe("import");
    expect(metadata.keep).toBe(true);
    expect(metadata.originalContainerTag).toBe(tag.tag);
  });

  it("aborts import on duplicate ids without writing", async () => {
    await stubEmbedding();
    await setupProject();
    const outputPath = join(baseDir, "memories.json");
    const { memoryPortabilityService } =
      await import("../src/services/memory-portability-service.js");
    await memoryPortabilityService.exportMemories({
      currentDirectory: projectDir,
      outputPath,
    });

    const result = await memoryPortabilityService.importMemories({
      currentDirectory: projectDir,
      inputPath: outputPath,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exist");
    expect(result.rejected?.[0]?.id).toBe("mem_portable");
  });

  it("rejects unsupported schema versions", async () => {
    await stubEmbedding();
    await setupProject();
    const badPath = join(baseDir, "bad.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        schemaVersion: 99,
        exportedAt: new Date().toISOString(),
        plugin: { package: "opencode-mem", version: "9.9.9" },
        source: {
          containerTag: "opencode_project_0123456789abcdef",
          scope: "project",
          scopeHash: "0123456789abcdef",
        },
        embedding: { model: "x", dimensions: 2 },
        memories: [],
      }),
      "utf-8"
    );

    const { memoryPortabilityService } =
      await import("../src/services/memory-portability-service.js");
    const result = await memoryPortabilityService.importMemories({
      currentDirectory: projectDir,
      inputPath: badPath,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export schemaVersion");
  });

  it("validates the export schema fixture", async () => {
    const { MemoryExportDocumentSchema } = await import("../src/shared/api/portability-schemas.js");
    const parsed = MemoryExportDocumentSchema.safeParse({
      schemaVersion: 1,
      exportedAt: "2026-08-04T00:00:00.000Z",
      plugin: { package: "opencode-mem", version: "2.23.0" },
      source: {
        containerTag: "opencode_project_0123456789abcdef",
        scope: "project",
        scopeHash: "0123456789abcdef",
      },
      embedding: { model: "test", dimensions: 2 },
      memories: [
        {
          id: "mem_1",
          content: "hello",
          createdAt: 1,
          tags: ["a"],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("imports more than 500 memories in one atomic transaction", async () => {
    await stubEmbedding();
    await setupProject();
    const largeTarget = join(baseDir, "large-target");
    mkdirSync(largeTarget, { recursive: true });
    const inputPath = join(baseDir, "large-export.json");
    const memories = Array.from({ length: 501 }, (_, index) => ({
      id: `mem_large_${index}`,
      content: `portable memory ${index}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      tags: ["bulk"],
    }));
    writeFileSync(
      inputPath,
      JSON.stringify({
        schemaVersion: 1,
        exportedAt: "2026-08-04T00:00:00.000Z",
        plugin: { package: "opencode-mem", version: "2.23.0" },
        source: {
          containerTag: "opencode_project_0123456789abcdef",
          scope: "project",
          scopeHash: "0123456789abcdef",
        },
        embedding: { model: "test", dimensions: 2 },
        memories,
      }),
      "utf-8"
    );

    const { memoryPortabilityService } =
      await import("../src/services/memory-portability-service.js");
    const result = await memoryPortabilityService.importMemories({
      currentDirectory: largeTarget,
      inputPath,
    });
    expect(result.success).toBe(true);
    expect(result.imported).toBe(501);

    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/services/turso/vector-search.js");
    const hash = getProjectTagInfo(largeTarget).tag.split("_").pop()!;
    const shard = (await tursoShardManager.getAllShards("project", hash))[0]!;
    expect(
      await tursoVectorSearch.countAllVectors(
        await tursoConnectionManager.getConnection(shard.dbPath)
      )
    ).toBe(501);
  });
});
