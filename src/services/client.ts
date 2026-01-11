import { embeddingService } from "./embedding.js";
import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import type { MemoryRecord, SearchResult } from "./sqlite/types.js";

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    const numValue = typeof timestamp === 'bigint' 
      ? Number(timestamp) 
      : Number(timestamp);
    
    if (isNaN(numValue) || numValue < 0) {
      return new Date().toISOString();
    }
    
    return new Date(numValue).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeJSONParse(jsonString: any): any {
  if (!jsonString || typeof jsonString !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

function extractScopeFromContainerTag(containerTag: string): { scope: 'user' | 'project', hash: string } {
  const parts = containerTag.split('_');
  if (parts.length >= 3) {
    const scope = parts[1] as 'user' | 'project';
    const hash = parts.slice(2).join('_');
    return { scope, hash };
  }
  return { scope: 'user', hash: containerTag };
}

interface ProfileData {
  static: string[];
  dynamic: string[];
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
        log("SQLite memory client initialized");
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

  async searchMemories(query: string, containerTag: string) {
    log("searchMemories: start", { containerTag });
    try {
      await this.initialize();

      const queryVector = await embeddingService.embedWithTimeout(query);
      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
     log("searchMemories: no shards found", { containerTag });
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const results = await vectorSearch.searchAcrossShards(
        shards,
        queryVector,
        containerTag,
        CONFIG.maxMemories,
        CONFIG.similarityThreshold
      );

      log("searchMemories: success", { count: results.length });
      return { success: true as const, results, total: results.length, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async getProfile(containerTag: string, query?: string) {
    log("getProfile: start", { containerTag });
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        log("getProfile: no shards found", { containerTag });
        return { success: true as const, profile: { static: [], dynamic: [] } };
      }

      const staticFacts: string[] = [];
      const dynamicFacts: string[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.listMemories(db, containerTag, CONFIG.maxProfileItems * 2);

        for (const m of memories) {
          if (m.type === "preference") {
            staticFacts.push(m.content);
          } else {
            dynamicFacts.push(m.content);
          }
        }
      }

      const profile: ProfileData = {
        static: staticFacts.slice(0, CONFIG.maxProfileItems),
        dynamic: dynamicFacts.slice(0, CONFIG.maxProfileItems),
      };

      log("getProfile: success", { hasProfile: true });
      return { success: true as const, profile };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("getProfile: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, profile: null };
    }
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: { 
      type?: MemoryType; 
      tool?: string; 
      displayName?: string;
      userName?: string;
      userEmail?: string;
      projectPath?: string;
      projectName?: string;
      gitRepoUrl?: string;
      [key: string]: unknown;
    }
  ) {
    log("addMemory: start", { containerTag, contentLength: content.length });
    try {
      await this.initialize();

      const vector = await embeddingService.embedWithTimeout(content);
      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shard = shardManager.getWriteShard(scope, hash);

      const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const now = Date.now();

      const record: MemoryRecord = {
        id,
        content,
        vector,
        containerTag,
        type: metadata?.type,
        createdAt: now,
        updatedAt: now,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
        displayName: metadata?.displayName,
        userName: metadata?.userName,
        userEmail: metadata?.userEmail,
        projectPath: metadata?.projectPath,
        projectName: metadata?.projectName,
        gitRepoUrl: metadata?.gitRepoUrl,
      };

      const db = connectionManager.getConnection(shard.dbPath);
      vectorSearch.insertVector(db, record);
      shardManager.incrementVectorCount(shard.id);

      log("addMemory: success", { id, shardId: shard.id });
      return { success: true as const, id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    log("deleteMemory: start", { memoryId });
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(memoryId);
      const shards = shardManager.getAllShards(scope, hash);

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memory = vectorSearch.getMemoryById(db, memoryId);

        if (memory) {
          vectorSearch.deleteVector(db, memoryId);
          shardManager.decrementVectorCount(shard.id);
          log("deleteMemory: success", { memoryId, shardId: shard.id });
          return { success: true };
        }
      }

      log("deleteMemory: not found", { memoryId });
      return { success: false, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async listMemories(containerTag: string, limit = 20) {
    log("listMemories: start", { containerTag, limit });
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        log("listMemories: no shards found", { containerTag });
        return {
          success: true as const,
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 }
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

      log("listMemories: success", { count: memories.length });
      return {
        success: true as const,
        memories,
        pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return {
        success: false as const,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 }
      };
    }
  }
}

export const memoryClient = new LocalMemoryClient();
