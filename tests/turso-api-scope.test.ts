import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("api memory shard scope", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("includes user-scope memories in stats, pin, and global search handlers", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-api-scope-"));

    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 768;

    const { closeTursoAndInvalidateCaches } = await import("../src/storage/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();

    const { tursoShardManager } = await import("../src/storage/turso/shard-manager.js");
    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const { tursoVectorSearch } = await import("../src/storage/turso/vector-search.js");
    const { handleStats, handlePinMemory, handleSearch } =
      await import("../src/runtime/http/api-handlers.js");
    const { embeddingService } = await import("../src/memory/embedding.js");
    const { userPromptManager } = await import("../src/memory/user-prompt/user-prompt-manager.js");

    const vector = new Float32Array(768);
    vector[0] = 1;

    const scopeHash = "c1c2c3d4e5f67890";
    const containerTag = `opencode_user_${scopeHash}`;

    const shard = await tursoShardManager.createShard("user", scopeHash, 0);
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await tursoVectorSearch.insertVector(db, {
      id: "mem_user_scope_1",
      content: "user scoped memory",
      vector,
      containerTag,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const stats = await handleStats();
    expect(stats.success).toBe(true);
    expect(stats.data?.byScope.user).toBe(1);
    expect(stats.data?.total).toBe(1);

    const pin = await handlePinMemory("mem_user_scope_1");
    expect(pin.success).toBe(true);

    const pinned = await tursoVectorSearch.getMemoryById(db, "mem_user_scope_1");
    expect(Number(pinned?.is_pinned)).toBe(1);

    const originalWarmup = embeddingService.warmup;
    const originalEmbedWithTimeout = embeddingService.embedWithTimeout;
    const originalSearchPrompts = userPromptManager.searchPrompts;
    embeddingService.warmup = async () => {};
    embeddingService.embedWithTimeout = async () => vector;
    userPromptManager.searchPrompts = async () => [];
    try {
      const search = await handleSearch("user scoped memory");
      expect(search.success).toBe(true);
      expect(search.data?.items.some((item) => item.id === "mem_user_scope_1")).toBe(true);
    } finally {
      embeddingService.warmup = originalWarmup;
      embeddingService.embedWithTimeout = originalEmbedWithTimeout;
      userPromptManager.searchPrompts = originalSearchPrompts;
    }
  });
});
