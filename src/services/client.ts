import { createHash } from "node:crypto";
import { embeddingService } from "./embedding.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { formatTagsForEmbedding, parseSessionIdFromMetadata } from "./turso/vector-utils.js";
import {
  extractScopeFromContainerTag,
  resolveMemoryScope,
  type MemoryScopeRef,
} from "./memory-scope.js";
import { CONFIG } from "../config.js";
import { log, serializeError } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import type { MemoryListFilters, MemoryRecord } from "./turso/types.js";
import { isMarkdownBackend, writeMemoryMarkdownFile } from "./markdown/backend.js";
import { pluginMemoryRelPath } from "./markdown/vault.js";

export type MemoryScope = "project" | "all-projects";

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);

    if (isNaN(numValue) || numValue < 0) {
      return new Date().toISOString();
    }

    return new Date(numValue).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeJSONParse(jsonString: any): any {
  if (!jsonString || typeof jsonString !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

function resolveScopeValue(scope: MemoryScope, containerTag: string): MemoryScopeRef[] {
  return resolveMemoryScope(scope, containerTag);
}

export class LocalMemoryClient {
  private initPromise: Promise<void> | null = null;
  private isInitialized: boolean = false;

  constructor() {}

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await ensureTursoReady();
        this.isInitialized = true;
      } catch (error) {
        this.initPromise = null;
        log("Turso initialization failed", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    await this.initialize();
    await embeddingService.warmup(progressCallback);
  }

  async isReady(): Promise<boolean> {
    return this.isInitialized && embeddingService.isWarmedUp;
  }

  getEmbeddingInitError(): string | null {
    return embeddingService.initError;
  }

  getStatus(): {
    dbConnected: boolean;
    modelLoaded: boolean;
    ready: boolean;
    embeddingError: string | null;
  } {
    return {
      dbConnected: this.isInitialized,
      modelLoaded: embeddingService.isWarmedUp,
      ready: this.isInitialized && embeddingService.isWarmedUp,
      embeddingError: embeddingService.initError,
    };
  }

  reset(): void {
    this.isInitialized = false;
    this.initPromise = null;
  }

  async close(): Promise<void> {
    // Release one plugin-instance lease. Only the last live instance closes the
    // process-wide Turso pool — otherwise a disposing session races sibling
    // idle handlers with "database connection is not open" (#443).
    const { releasePluginTurso } = await import("./turso/lifecycle.js");
    const closed = await releasePluginTurso();
    if (closed) {
      // Process-wide like the pool: only the last instance may drop the model.
      // Optional: test stubs for embeddingService may omit dispose.
      if (typeof embeddingService.dispose === "function") {
        await embeddingService.dispose("client-close");
      }
      this.reset();
    }
  }

  async searchMemories(
    query: string,
    containerTag: string,
    scope: MemoryScope = "project",
    options: { limit?: number; similarityThreshold?: number } = {}
  ) {
    try {
      await this.initialize();

      const queryVector = await embeddingService.embedWithTimeout(query, { task: "query" });
      const resolved = resolveScopeValue(scope, containerTag);
      const shards = (
        await Promise.all(
          resolved.map((ref) => tursoShardManager.getAllShards(ref.scope, ref.hash))
        )
      ).flat();

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const limit = options.limit ?? CONFIG.maxMemories;
      const similarityThreshold = options.similarityThreshold ?? CONFIG.similarityThreshold;

      const { results, warnings } = await tursoVectorSearch.searchAcrossShards(
        shards,
        queryVector,
        scope === "all-projects" ? "" : containerTag,
        limit,
        similarityThreshold,
        query
      );

      return {
        success: true as const,
        results,
        total: results.length,
        timing: 0,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: {
      type?: MemoryType;
      source?: "manual" | "auto-capture" | "import" | "api";
      tags?: string[];
      tool?: string;
      sessionID?: string;
      reasoning?: string;
      captureTimestamp?: number;
      displayName?: string;
      userName?: string;
      userEmail?: string;
      projectPath?: string;
      projectName?: string;
      gitRepoUrl?: string;
      [key: string]: unknown;
    }
  ) {
    let phase: "embed" | "embed_tags" | "write" = "embed";
    try {
      await this.initialize();

      const tags = metadata?.tags || [];
      phase = "embed";
      const vector = await embeddingService.embedWithTimeout(content, { task: "document" });
      let tagsVector: Float32Array | undefined = undefined;

      if (tags.length > 0) {
        phase = "embed_tags";
        tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
          task: "document",
        });
      }

      const { scope, hash } = extractScopeFromContainerTag(containerTag);

      phase = "write";
      return await tursoShardManager.withScopeWriteLock(scope, hash, async () => {
        const promptId = metadata?.promptId;
        const replayId =
          metadata?.source === "auto-capture" && typeof promptId === "string" && promptId.trim()
            ? `mem_capture_${createHash("sha256")
                .update(JSON.stringify([containerTag, promptId]))
                .digest("hex")}`
            : null;
        if (replayId) {
          // A crash can leave the memory committed before its prompt is marked captured.
          // Search older rotated shards too, and retain soft deletion as an explicit decision.
          const shards = await tursoShardManager.getAllShards(scope, hash);
          for (const existingShard of shards) {
            const db = await tursoConnectionManager.getConnection(existingShard.dbPath);
            const existing = await db.get(
              "SELECT id FROM memories WHERE id = ? AND container_tag = ? LIMIT 1",
              [replayId, containerTag]
            );
            if (existing) return { success: true as const, id: replayId };
          }
        }
        const shard = await tursoShardManager.getWriteShard(scope, hash);

        const id = replayId ?? `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const now = Date.now();

        const {
          displayName,
          userName,
          userEmail,
          projectPath,
          projectName,
          gitRepoUrl,
          type,
          tags: _tags,
          ...dynamicMetadata
        } = metadata || {};

        const sessionId =
          typeof dynamicMetadata.sessionID === "string" ? dynamicMetadata.sessionID : undefined;

        if (isMarkdownBackend()) {
          writeMemoryMarkdownFile({
            id,
            content,
            type,
            tags,
            containerTag,
            createdAt: now,
            updatedAt: now,
            source: typeof dynamicMetadata.source === "string" ? dynamicMetadata.source : "manual",
            title: displayName,
          });
          dynamicMetadata.markdownRelPath = pluginMemoryRelPath(id);
          if (!dynamicMetadata.source) dynamicMetadata.source = "manual";
        }

        const record: MemoryRecord = {
          id,
          content,
          vector,
          tagsVector,
          containerTag,
          tags: tags.length > 0 ? tags.join(",") : undefined,
          type,
          createdAt: now,
          updatedAt: now,
          displayName,
          userName,
          userEmail,
          projectPath,
          projectName,
          gitRepoUrl,
          sessionId,
          metadata:
            Object.keys(dynamicMetadata).length > 0 ? JSON.stringify(dynamicMetadata) : undefined,
        };

        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        await tursoVectorSearch.insertVector(db, record);
        await tursoShardManager.incrementVectorCount(shard.id);

        return {
          success: true as const,
          id,
        };
      });
    } catch (error) {
      const serialized = serializeError(error);
      log("addMemory: error", { phase, ...serialized });
      return { success: false as const, error: serialized.error };
    }
  }

  async updateMemory(
    id: string,
    data: {
      content?: string;
      type?: MemoryType;
      tags?: string[];
      metadataPatch?: Record<string, unknown>;
    }
  ) {
    try {
      if (!id) return { success: false as const, error: "id is required" };
      await this.initialize();
      await embeddingService.warmup();

      const userShards = await tursoShardManager.getAllShards("user", "");
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const shards = [...userShards, ...projectShards];

      let foundShard = null;
      let existingMemory = null;
      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memory = await tursoVectorSearch.getMemoryById(db, id);
        if (memory) {
          foundShard = shard;
          existingMemory = memory;
          break;
        }
      }
      if (!foundShard || !existingMemory) {
        return { success: false as const, error: "Memory not found" };
      }

      const newContent = data.content || String(existingMemory.content);
      const existingTags = existingMemory.tags ? String(existingMemory.tags) : "";
      const tags =
        data.tags || (existingTags ? existingTags.split(",").map((t: string) => t.trim()) : []);
      const vector = await embeddingService.embedWithTimeout(newContent, { task: "document" });
      let tagsVector: Float32Array | undefined = undefined;
      if (tags.length > 0) {
        tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
          task: "document",
        });
      }

      const db = await tursoConnectionManager.getConnection(foundShard.dbPath);
      const updatedAt = Date.now();
      const memoryType =
        data.type || (existingMemory.type ? String(existingMemory.type) : undefined);
      const containerTag = String(existingMemory.container_tag);
      const existingMeta = safeJSONParse(existingMemory.metadata) || {};
      if (data.metadataPatch) Object.assign(existingMeta, data.metadataPatch);

      if (isMarkdownBackend()) {
        writeMemoryMarkdownFile({
          id,
          content: newContent,
          type: memoryType,
          tags,
          containerTag,
          createdAt: Number(existingMemory.created_at),
          updatedAt,
          source: typeof existingMeta.source === "string" ? existingMeta.source : "api",
          title: existingMemory.display_name ? String(existingMemory.display_name) : undefined,
        });
        existingMeta.markdownRelPath = pluginMemoryRelPath(id);
      }

      const metadataJson = JSON.stringify(existingMeta);
      const isPinned = Number(existingMemory.is_pinned ?? 0) === 1 ? 1 : 0;
      const deletedAt =
        existingMemory.deleted_at == null || existingMemory.deleted_at === undefined
          ? null
          : Number(existingMemory.deleted_at);

      await db.transaction("write", async (tx) => {
        await tx.execute({ sql: `DELETE FROM memories WHERE id = ?`, args: [id] });
        await tx.execute({
          sql: `
        INSERT INTO memories (
          id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
          metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url,
          is_pinned, deleted_at
        ) VALUES (?, ?, vector32(?), ${tagsVector ? "vector32(?)" : "NULL"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
          args: [
            id,
            newContent,
            JSON.stringify(Array.from(vector)),
            ...(tagsVector ? [JSON.stringify(Array.from(tagsVector))] : []),
            containerTag,
            tags.length > 0 ? tags.join(",") : null,
            memoryType || null,
            Number(existingMemory.created_at),
            updatedAt,
            metadataJson,
            existingMemory.session_id
              ? String(existingMemory.session_id)
              : parseSessionIdFromMetadata(
                  existingMemory.metadata ? String(existingMemory.metadata) : null
                ),
            existingMemory.display_name ? String(existingMemory.display_name) : null,
            existingMemory.user_name ? String(existingMemory.user_name) : null,
            existingMemory.user_email ? String(existingMemory.user_email) : null,
            existingMemory.project_path ? String(existingMemory.project_path) : null,
            existingMemory.project_name ? String(existingMemory.project_name) : null,
            existingMemory.git_repo_url ? String(existingMemory.git_repo_url) : null,
            isPinned,
            deletedAt,
          ],
        });
      });

      return { success: true as const };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("updateMemory: error", { id, error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string, metaPatch?: Record<string, unknown>) {
    try {
      await this.initialize();

      const userShards = await tursoShardManager.getAllShards("user", "");
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memory = await tursoVectorSearch.getMemoryById(db, memoryId);

        if (memory) {
          // Soft-delete into trash (recoverable). Hard-purge happens via cleanup.
          const ok = await tursoVectorSearch.softDeleteVector(db, memoryId, metaPatch);
          return ok ? { success: true } : { success: false, error: "Memory not found" };
        }
      }

      return { success: false, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async getMemoryById(memoryId: string) {
    try {
      await this.initialize();
      const userShards = await tursoShardManager.getAllShards("user", "");
      const projectShards = await tursoShardManager.getAllShards("project", "");
      for (const shard of [...userShards, ...projectShards]) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memory = await tursoVectorSearch.getMemoryById(db, memoryId);
        if (memory) {
          return {
            success: true as const,
            memory: {
              id: String(memory.id),
              content: String(memory.content),
              isPinned: Number(memory.is_pinned ?? 0) === 1,
              containerTag: String(memory.container_tag),
              type: memory.type ? String(memory.type) : undefined,
              tags: memory.tags
                ? String(memory.tags)
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                : [],
            },
          };
        }
      }
      return { success: false as const, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false as const, error: errorMessage };
    }
  }

  async listMemories(
    containerTag: string,
    limit = 20,
    scope: MemoryScope = "project",
    filters: MemoryListFilters = {}
  ) {
    try {
      await this.initialize();

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = (
        await Promise.all(
          resolved.map((ref) => tursoShardManager.getAllShards(ref.scope, ref.hash))
        )
      ).flat();

      if (shards.length === 0) {
        return {
          success: true as const,
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.listMemories(
          db,
          scope === "all-projects" ? "" : containerTag,
          limit,
          filters
        );
        allMemories.push(...memories);
      }

      // Match per-shard SQL (is_pinned DESC, created_at DESC) when selecting the
      // merged limit, then present the chosen rows by recency for injection order.
      allMemories.sort((a, b) => {
        const pinDiff = Number(b.is_pinned ?? 0) - Number(a.is_pinned ?? 0);
        if (pinDiff !== 0) return pinDiff;
        return Number(b.created_at) - Number(a.created_at);
      });
      const selected = allMemories.slice(0, limit);
      selected.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const memories = selected.map((r: any) => ({
        id: r.id,
        summary: r.content,
        createdAt: safeToISOString(r.created_at),
        metadata: safeJSONParse(r.metadata),
        displayName: r.display_name,
        userName: r.user_name,
        userEmail: r.user_email,
        projectPath: r.project_path,
        projectName: r.project_name,
        gitRepoUrl: r.git_repo_url,
      }));

      return {
        success: true as const,
        memories,
        pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return {
        success: false as const,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
      };
    }
  }

  async ensureStorageReady(): Promise<void> {
    await this.initialize();
  }

  async listShards(currentDirectory: string) {
    try {
      await this.initialize();
      const { shardInventoryService } = await import("./shard-inventory-service.js");
      return await shardInventoryService.listShards(currentDirectory);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listShards: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async migrateProjectPath(options: {
    currentDirectory: string;
    fromPath?: string;
    fromHash?: string;
    dryRun?: boolean;
    allowLinkedSource?: boolean;
  }) {
    try {
      await this.initialize();
      const { shardPathMigrationService } = await import("./shard-path-migration-service.js");
      return await shardPathMigrationService.migrate(options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("migrateProjectPath: error", { error: errorMessage });
      return { success: false as const, dryRun: Boolean(options.dryRun), error: errorMessage };
    }
  }

  async exportMemories(currentDirectory: string, outputPath: string) {
    try {
      await this.initialize();
      const { memoryPortabilityService } = await import("./memory-portability-service.js");
      return await memoryPortabilityService.exportMemories({ currentDirectory, outputPath });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("exportMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async importMemories(currentDirectory: string, inputPath: string, dryRun?: boolean) {
    try {
      await this.initialize();
      const { memoryPortabilityService } = await import("./memory-portability-service.js");
      return await memoryPortabilityService.importMemories({
        currentDirectory,
        inputPath,
        dryRun,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("importMemories: error", { error: errorMessage });
      return { success: false as const, dryRun: Boolean(dryRun), error: errorMessage };
    }
  }

  async searchMemoriesBySessionID(sessionID: string, containerTag: string, limit: number = 10) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = await tursoShardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.getMemoriesBySessionID(db, sessionID);
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const results = allMemories.slice(0, limit).map((row: any) => ({
        id: row.id,
        memory: row.content,
        similarity: 1.0,
        tags: row.tags || [],
        metadata: row.metadata || {},
        containerTag: row.container_tag,
        displayName: row.display_name,
        userName: row.user_name,
        userEmail: row.user_email,
        projectPath: row.project_path,
        projectName: row.project_name,
        gitRepoUrl: row.git_repo_url,
        createdAt: row.created_at,
      }));

      return { success: true as const, results, total: results.length, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemoriesBySessionID: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }
}

export const memoryClient = new LocalMemoryClient();
