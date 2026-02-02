import { embeddingService } from "./embedding.js";
import { DatabaseFactory } from "./database/factory.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import type { IDatabaseAdapter, IVectorSearch } from "./database/interfaces.js";
import type { MemoryRecord } from "./database/types.js";

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }

    if (timestamp instanceof Date) {
      return timestamp.toISOString();
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
    return jsonString; // Return as-is if already an object (PostgreSQL JSONB)
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

export class LocalMemoryClient {
  private initPromise: Promise<void> | null = null;
  private isInitialized: boolean = false;
  private adapter: IDatabaseAdapter | null = null;
  private vectorSearch: IVectorSearch | null = null;

  constructor() {}

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.adapter = await DatabaseFactory.create({
          databaseType: CONFIG.databaseType,
          databaseUrl: CONFIG.databaseUrl,
          storagePath: CONFIG.storagePath,
          customSqlitePath: CONFIG.customSqlitePath,
          maxVectorsPerShard: CONFIG.maxVectorsPerShard,
          embeddingDimensions: CONFIG.embeddingDimensions,
          embeddingModel: CONFIG.embeddingModel,
        });
        this.vectorSearch = this.adapter.getVectorSearch();
        this.isInitialized = true;
        log(`Database initialized (${CONFIG.databaseType})`);
      } catch (error) {
        this.initPromise = null;
        log("Database initialization failed", { error: String(error) });
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

  async close(): Promise<void> {
    await DatabaseFactory.close();
    this.adapter = null;
    this.vectorSearch = null;
    this.isInitialized = false;
    this.initPromise = null;
  }

  async searchMemories(query: string, containerTag: string) {
    try {
      await this.initialize();

      if (!this.vectorSearch) {
        throw new Error("Vector search not initialized");
      }

      const queryVector = await embeddingService.embedWithTimeout(query);

      const results = await this.vectorSearch.searchMemories(
        Array.from(queryVector),
        containerTag,
        CONFIG.maxMemories,
        CONFIG.similarityThreshold,
        query
      );

      return { success: true as const, results, total: results.length, timing: 0 };
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
    try {
      await this.initialize();

      if (!this.vectorSearch) {
        throw new Error("Vector search not initialized");
      }

      const tags = metadata?.tags || [];
      const embedding = await embeddingService.embedWithTimeout(content);
      let tagsEmbedding: number[] | undefined = undefined;

      if (tags.length > 0) {
        const tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
        tagsEmbedding = Array.from(tagsVector);
      }

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
        embedding: Array.from(embedding),
        tagsEmbedding,
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

      await this.vectorSearch.insertMemory(record);

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

      if (!this.vectorSearch) {
        throw new Error("Vector search not initialized");
      }

      const deleted = await this.vectorSearch.deleteMemory(memoryId);

      if (deleted) {
        return { success: true };
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

      if (!this.vectorSearch) {
        throw new Error("Vector search not initialized");
      }

      const rows = await this.vectorSearch.listMemories(containerTag, limit);

      const memories = rows.map((r: any) => ({
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

  /**
   * Get the database adapter (for advanced operations)
   */
  async getAdapter(): Promise<IDatabaseAdapter> {
    await this.initialize();
    if (!this.adapter) {
      throw new Error("Database adapter not initialized");
    }
    return this.adapter;
  }
}

export const memoryClient = new LocalMemoryClient();
