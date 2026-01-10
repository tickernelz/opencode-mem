import { connect } from "@lancedb/lancedb";
import { pipeline, env } from "@xenova/transformers";
import { existsSync, mkdirSync } from "node:fs";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";

env.allowLocalModels = true;
env.allowRemoteModels = true;

const TIMEOUT_MS = 30000;

interface MemoryRecord {
  id: string;
  content: string;
  vector: number[];
  containerTag: string;
  type?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: string;
}

interface SearchResult {
  id: string;
  memory: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

interface ProfileData {
  static: string[];
  dynamic: string[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.pipe) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
          log("Using OpenAI-compatible API for embeddings");
          return;
        }
        log("Initializing local embedding model", { model: CONFIG.embeddingModel });
        this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel);
        log("Embedding model initialized");
      } catch (error) {
        log("Failed to initialize embedding model", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize();

    if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
      const response = await fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CONFIG.embeddingApiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: CONFIG.embeddingModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`API embedding failed: ${response.statusText}`);
      }

      const data: any = await response.json();
      return data.data[0].embedding;
    }

    const output = await this.pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }
}

export class LocalMemoryClient {
  private db: any = null;
  private table: any = null;
  private embedder: EmbeddingService;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.embedder = new EmbeddingService();
  }

  private async initialize(): Promise<void> {
    if (this.db && this.table) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        if (!existsSync(CONFIG.storagePath)) {
          mkdirSync(CONFIG.storagePath, { recursive: true });
        }

        this.db = await connect(CONFIG.storagePath);
        
        const tableNames = await this.db.tableNames();
        if (tableNames.includes("memories")) {
          this.table = await this.db.openTable("memories");
        } else {
          const schema = [
            { name: "id", type: "string" },
            { name: "content", type: "string" },
            { name: "vector", type: "float32[]" },
            { name: "containerTag", type: "string" },
            { name: "type", type: "string" },
            { name: "createdAt", type: "int64" },
            { name: "updatedAt", type: "int64" },
            { name: "metadata", type: "string" },
          ];
          this.table = await this.db.createTable("memories", [], { schema });
        }

        log("LanceDB initialized", { path: CONFIG.storagePath });
      } catch (error) {
        log("Failed to initialize LanceDB", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
  }

  async searchMemories(query: string, containerTag: string) {
    log("searchMemories: start", { containerTag });
    try {
      await this.initialize();
      
      const queryVector = await withTimeout(
        this.embedder.embed(query),
        TIMEOUT_MS
      );

      const results = await this.table!
        .search(queryVector)
        .where(`containerTag = '${containerTag}'`)
        .limit(CONFIG.maxMemories)
        .execute();

      const mapped: SearchResult[] = results.map((r: any) => ({
        id: r.id,
        memory: r.content,
        similarity: 1 - (r._distance || 0),
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      })).filter((r: SearchResult) => r.similarity >= CONFIG.similarityThreshold);

      log("searchMemories: success", { count: mapped.length });
      return { success: true as const, results: mapped, total: mapped.length, timing: 0 };
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

      const results = await this.table!
        .filter(`containerTag = '${containerTag}'`)
        .limit(CONFIG.maxProfileItems * 2)
        .execute();

      const staticFacts: string[] = [];
      const dynamicFacts: string[] = [];

      for (const r of results) {
        const content = r.content;
        if (r.type === "preference") {
          staticFacts.push(content);
        } else {
          dynamicFacts.push(content);
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
    metadata?: { type?: MemoryType; tool?: string; [key: string]: unknown }
  ) {
    log("addMemory: start", { containerTag, contentLength: content.length });
    try {
      await this.initialize();

      const vector = await withTimeout(
        this.embedder.embed(content),
        TIMEOUT_MS
      );

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
      };

      await this.table!.add([record]);

      log("addMemory: success", { id });
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

      await this.table!.delete(`id = '${memoryId}'`);

      log("deleteMemory: success", { memoryId });
      return { success: true };
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

      const results = await this.table!
        .filter(`containerTag = '${containerTag}'`)
        .limit(limit)
        .execute();

      const memories = results.map((r: any) => ({
        id: r.id,
        summary: r.content,
        createdAt: new Date(r.createdAt).toISOString(),
        metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
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
