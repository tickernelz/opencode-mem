/**
 * SQLite database adapter implementation
 */

import type { Database } from "bun:sqlite";
import type {
  IDatabaseAdapter,
  IVectorSearch,
  IShardManager,
  ShardInfo,
} from "../interfaces.js";
import type {
  MemoryRecord,
  SearchResult,
  MemoryRow,
  DistinctTagRow,
  DatabaseConfig,
} from "../types.js";
import { ConnectionManager } from "./connection-manager.js";
import { ShardManager } from "./shard-manager.js";
import { VectorSearch } from "./vector-search.js";
import type { MemoryRecord as SQLiteMemoryRecord } from "./types.js";

/**
 * Helper to convert number[] to Float32Array
 */
function toFloat32Array(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

/**
 * SQLite Vector Search wrapper that implements IVectorSearch
 */
class SQLiteVectorSearchWrapper implements IVectorSearch {
  private vectorSearch: VectorSearch;
  private shardManager: ShardManager;
  private connectionManager: ConnectionManager;

  constructor(
    vectorSearch: VectorSearch,
    shardManager: ShardManager,
    connectionManager: ConnectionManager
  ) {
    this.vectorSearch = vectorSearch;
    this.shardManager = shardManager;
    this.connectionManager = connectionManager;
  }

  private extractScopeFromContainerTag(containerTag: string): {
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

  async insertMemory(record: MemoryRecord): Promise<void> {
    const { scope, hash } = this.extractScopeFromContainerTag(record.containerTag);
    const shard = this.shardManager.getWriteShard(scope, hash);
    const db = this.connectionManager.getConnection(shard.dbPath);

    // Convert to SQLite format
    const sqliteRecord: SQLiteMemoryRecord = {
      id: record.id,
      content: record.content,
      vector: toFloat32Array(record.embedding),
      tagsVector: record.tagsEmbedding ? toFloat32Array(record.tagsEmbedding) : undefined,
      containerTag: record.containerTag,
      tags: record.tags,
      type: record.type,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      metadata: record.metadata,
      displayName: record.displayName,
      userName: record.userName,
      userEmail: record.userEmail,
      projectPath: record.projectPath,
      projectName: record.projectName,
      gitRepoUrl: record.gitRepoUrl,
    };

    this.vectorSearch.insertVector(db, sqliteRecord);
    this.shardManager.incrementVectorCount(shard.id);
  }

  async searchMemories(
    queryVector: number[],
    containerTag: string,
    limit: number,
    threshold: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    const { scope, hash } = this.extractScopeFromContainerTag(containerTag);
    const shards = this.shardManager.getAllShards(scope, hash);

    if (shards.length === 0) {
      return [];
    }

    return this.vectorSearch.searchAcrossShards(
      shards,
      toFloat32Array(queryVector),
      containerTag,
      limit,
      threshold,
      queryText
    );
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const memory = this.vectorSearch.getMemoryById(db, memoryId);

      if (memory) {
        this.vectorSearch.deleteVector(db, memoryId);
        this.shardManager.decrementVectorCount(shard.id);
        return true;
      }
    }

    return false;
  }

  async listMemories(containerTag: string, limit: number): Promise<MemoryRow[]> {
    const { scope, hash } = this.extractScopeFromContainerTag(containerTag);
    const shards = this.shardManager.getAllShards(scope, hash);

    const allMemories: any[] = [];

    for (const shard of shards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const memories = this.vectorSearch.listMemories(db, containerTag, limit);
      allMemories.push(...memories);
    }

    allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return allMemories.slice(0, limit);
  }

  async getAllMemories(): Promise<MemoryRow[]> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    const allMemories: any[] = [];

    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const memories = this.vectorSearch.getAllMemories(db);
      allMemories.push(...memories);
    }

    allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return allMemories;
  }

  async getMemoryById(memoryId: string): Promise<MemoryRow | null> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const memory = this.vectorSearch.getMemoryById(db, memoryId);
      if (memory) {
        return memory;
      }
    }

    return null;
  }

  async countMemories(containerTag: string): Promise<number> {
    const { scope, hash } = this.extractScopeFromContainerTag(containerTag);
    const shards = this.shardManager.getAllShards(scope, hash);

    let total = 0;
    for (const shard of shards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      total += this.vectorSearch.countVectors(db, containerTag);
    }

    return total;
  }

  async countAllMemories(): Promise<number> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    let total = 0;
    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      total += this.vectorSearch.countAllVectors(db);
    }

    return total;
  }

  async getDistinctTags(): Promise<DistinctTagRow[]> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    const allTags: DistinctTagRow[] = [];
    const seen = new Set<string>();

    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const tags = this.vectorSearch.getDistinctTags(db);
      for (const tag of tags) {
        const key = tag.container_tag;
        if (!seen.has(key)) {
          seen.add(key);
          allTags.push(tag);
        }
      }
    }

    return allTags;
  }

  async pinMemory(memoryId: string): Promise<void> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const memory = this.vectorSearch.getMemoryById(db, memoryId);
      if (memory) {
        this.vectorSearch.pinMemory(db, memoryId);
        return;
      }
    }
  }

  async unpinMemory(memoryId: string): Promise<void> {
    const userShards = this.shardManager.getAllShards("user", "");
    const projectShards = this.shardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    for (const shard of allShards) {
      const db = this.connectionManager.getConnection(shard.dbPath);
      const memory = this.vectorSearch.getMemoryById(db, memoryId);
      if (memory) {
        this.vectorSearch.unpinMemory(db, memoryId);
        return;
      }
    }
  }
}

/**
 * SQLite Shard Manager wrapper that implements IShardManager
 */
class SQLiteShardManagerWrapper implements IShardManager {
  private shardManager: ShardManager;

  constructor(shardManager: ShardManager) {
    this.shardManager = shardManager;
  }

  getActiveShard(scope: "user" | "project", scopeHash: string): ShardInfo | null {
    return this.shardManager.getActiveShard(scope, scopeHash);
  }

  getAllShards(scope: "user" | "project", scopeHash: string): ShardInfo[] {
    return this.shardManager.getAllShards(scope, scopeHash);
  }

  getWriteShard(scope: "user" | "project", scopeHash: string): ShardInfo {
    return this.shardManager.getWriteShard(scope, scopeHash);
  }

  incrementVectorCount(shardId: number): void {
    this.shardManager.incrementVectorCount(shardId);
  }

  decrementVectorCount(shardId: number): void {
    this.shardManager.decrementVectorCount(shardId);
  }

  getShardByPath(dbPath: string): ShardInfo | null {
    return this.shardManager.getShardByPath(dbPath);
  }

  deleteShard(shardId: number): void {
    this.shardManager.deleteShard(shardId);
  }
}

/**
 * SQLite Database Adapter
 */
export class SQLiteAdapter implements IDatabaseAdapter {
  private config: DatabaseConfig;
  private connectionManager: ConnectionManager;
  private shardManager: ShardManager | null = null;
  private vectorSearch: VectorSearch;
  private vectorSearchWrapper: SQLiteVectorSearchWrapper | null = null;
  private shardManagerWrapper: SQLiteShardManagerWrapper | null = null;
  private initialized = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.connectionManager = new ConnectionManager();
    this.vectorSearch = new VectorSearch();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // ShardManager initializes itself when constructed
    this.shardManager = new ShardManager();
    this.vectorSearchWrapper = new SQLiteVectorSearchWrapper(
      this.vectorSearch,
      this.shardManager,
      this.connectionManager
    );
    this.shardManagerWrapper = new SQLiteShardManagerWrapper(this.shardManager);
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.connectionManager.closeAll();
    this.initialized = false;
    this.shardManager = null;
    this.vectorSearchWrapper = null;
    this.shardManagerWrapper = null;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  getVectorSearch(): IVectorSearch {
    if (!this.vectorSearchWrapper) {
      throw new Error("SQLiteAdapter not initialized. Call initialize() first.");
    }
    return this.vectorSearchWrapper;
  }

  getShardManager(): IShardManager {
    if (!this.shardManagerWrapper) {
      throw new Error("SQLiteAdapter not initialized. Call initialize() first.");
    }
    return this.shardManagerWrapper;
  }
}
