import { embeddingService } from "./embedding.js";
import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import type { MemoryRecord } from "./sqlite/types.js";

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

function extractScopeFromContainerTag(containerTag: string): {
  scope: "user" | "project";
  hash: string;
} {
  const parts = containerTag.split("_");
  if (parts.length >= 3) {
    const scope = parts[1] as "user" | "project";
    const hash = parts.slice(2).join("_");
    return { scope, hash };
  }
  return { scope: "user", hash: containerTag };
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
        this.isInitialized = true;
      } catch (error) {
        this.initPromise = null;
        log("SQLite initialization failed", { error: String(error) });
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

  getStatus(): {
    dbConnected: boolean;
    modelLoaded: boolean;
    ready: boolean;
  } {
    return {
      dbConnected: this.isInitialized,
      modelLoaded: embeddingService.isWarmedUp,
      ready: this.isInitialized && embeddingService.isWarmedUp,
    };
  }

  close(): void {
    connectionManager.closeAll();
  }

  async searchMemories(query: string, containerTag: string) {
    return this.hybridSearch(query, containerTag);
  }

  async fullTextSearch(query: string, containerTag: string) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const shardPromises = shards.map(async (shard) => {
        try {
          const db = connectionManager.getConnection(shard.dbPath);
          return vectorSearch.fullTextSearch(db, query, containerTag, CONFIG.maxMemories);
        } catch (error) {
          log("fullTextSearch: shard search error", { shardId: shard.id, error: String(error) });
          return [];
        }
      });

      const results = (await Promise.all(shardPromises)).flat();
      const dedupedById = new Map<string, any>();

      for (const result of results) {
        const existing = dedupedById.get(result.id);
        if (!existing || result.similarity > existing.similarity) {
          dedupedById.set(result.id, result);
        }
      }

      const dedupedResults = Array.from(dedupedById.values()).sort(
        (a, b) => b.similarity - a.similarity
      );

      return {
        success: true as const,
        results: dedupedResults.slice(0, CONFIG.maxMemories),
        total: dedupedResults.length,
        timing: 0,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("fullTextSearch: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async hybridSearch(query: string, containerTag: string) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const vectorPromise = (async () => {
        const queryVector = await embeddingService.embedWithTimeout(query);
        return vectorSearch.searchAcrossShards(
          shards,
          queryVector,
          containerTag,
          CONFIG.maxMemories,
          CONFIG.similarityThreshold,
          query
        );
      })();

      const ftsPromise = this.fullTextSearch(query, containerTag);
      const [vectorResults, ftsResponse] = await Promise.all([vectorPromise, ftsPromise]);
      const ftsResults = ftsResponse.success ? ftsResponse.results : [];

      const fusedById = new Map<string, { result: any; score: number }>();

      for (const [i, result] of vectorResults.entries()) {
        const vectorRank = 1 / (i + 1);
        fusedById.set(result.id, {
          result,
          score: 0.6 * vectorRank,
        });
      }

      for (const [i, result] of ftsResults.entries()) {
        const ftsRank = 1 / (i + 1);
        const existing = fusedById.get(result.id);

        if (existing) {
          existing.score += 0.4 * ftsRank;
          if (result.similarity > existing.result.similarity) {
            existing.result = result;
          }
        } else {
          fusedById.set(result.id, {
            result,
            score: 0.4 * ftsRank,
          });
        }
      }

      const combinedResults = Array.from(fusedById.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, CONFIG.maxMemories)
        .map((entry) => ({
          ...entry.result,
          similarity: entry.score,
        }));

      return {
        success: true as const,
        results: combinedResults,
        total: combinedResults.length,
        timing: 0,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("hybridSearch: error", { error: errorMessage });
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
    try {
      await this.initialize();

      const tags = metadata?.tags || [];
      const vector = await embeddingService.embedWithTimeout(content);
      let tagsVector: Float32Array | undefined = undefined;

      if (tags.length > 0) {
        tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
      }

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shard = shardManager.getWriteShard(scope, hash);

      const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
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
        metadata:
          Object.keys(dynamicMetadata).length > 0 ? JSON.stringify(dynamicMetadata) : undefined,
      };

      const db = connectionManager.getConnection(shard.dbPath);
      vectorSearch.insertVector(db, record);
      shardManager.incrementVectorCount(shard.id);

      return { success: true as const, id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    try {
      await this.initialize();

      const userShards = shardManager.getAllShards("user", "");
      const projectShards = shardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      for (const shard of allShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memory = vectorSearch.getMemoryById(db, memoryId);

        if (memory) {
          vectorSearch.deleteVector(db, memoryId);
          shardManager.decrementVectorCount(shard.id);
          return { success: true };
        }
      }

      return { success: false, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async listMemories(containerTag: string, limit = 20) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        return {
          success: true as const,
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.listMemories(db, containerTag, limit);
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const memories = allMemories.slice(0, limit).map((r: any) => ({
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

  async searchMemoriesBySessionID(sessionID: string, containerTag: string, limit: number = 10) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.getMemoriesBySessionID(db, sessionID);
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => b.created_at - a.created_at);

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
