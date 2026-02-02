/**
 * PostgreSQL database adapter implementation
 */

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
import { VectorSearch } from "./vector-search.js";
import type { MemoryRecord as PgMemoryRecord } from "./types.js";

/**
 * PostgreSQL Vector Search wrapper that implements IVectorSearch
 */
class PostgresVectorSearchWrapper implements IVectorSearch {
  private vectorSearch: VectorSearch;

  constructor(vectorSearch: VectorSearch) {
    this.vectorSearch = vectorSearch;
  }

  async insertMemory(record: MemoryRecord): Promise<void> {
    // Convert to PostgreSQL format
    const pgRecord: PgMemoryRecord = {
      id: record.id,
      content: record.content,
      embedding: record.embedding,
      tagsEmbedding: record.tagsEmbedding,
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
      isPinned: record.isPinned,
    };

    await this.vectorSearch.insertMemory(pgRecord);
  }

  async searchMemories(
    queryVector: number[],
    containerTag: string,
    limit: number,
    threshold: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    return this.vectorSearch.searchMemories(
      queryVector,
      containerTag,
      limit,
      threshold,
      queryText
    );
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    return this.vectorSearch.deleteMemory(memoryId);
  }

  async listMemories(containerTag: string, limit: number): Promise<MemoryRow[]> {
    return this.vectorSearch.listMemories(containerTag, limit);
  }

  async getAllMemories(): Promise<MemoryRow[]> {
    return this.vectorSearch.getAllMemories();
  }

  async getMemoryById(memoryId: string): Promise<MemoryRow | null> {
    return this.vectorSearch.getMemoryById(memoryId);
  }

  async countMemories(containerTag: string): Promise<number> {
    return this.vectorSearch.countMemories(containerTag);
  }

  async countAllMemories(): Promise<number> {
    return this.vectorSearch.countAllMemories();
  }

  async getDistinctTags(): Promise<DistinctTagRow[]> {
    return this.vectorSearch.getDistinctTags();
  }

  async pinMemory(memoryId: string): Promise<void> {
    await this.vectorSearch.pinMemory(memoryId);
  }

  async unpinMemory(memoryId: string): Promise<void> {
    await this.vectorSearch.unpinMemory(memoryId);
  }
}

/**
 * No-op Shard Manager for PostgreSQL (sharding not supported)
 */
class NoOpShardManager implements IShardManager {
  getActiveShard(_scope: "user" | "project", _scopeHash: string): ShardInfo | null {
    return null;
  }

  getAllShards(_scope: "user" | "project", _scopeHash: string): ShardInfo[] {
    return [];
  }

  getWriteShard(_scope: "user" | "project", _scopeHash: string): ShardInfo {
    throw new Error("Sharding is not supported in PostgreSQL adapter");
  }

  incrementVectorCount(_shardId: number): void {
    // No-op
  }

  decrementVectorCount(_shardId: number): void {
    // No-op
  }

  getShardByPath(_dbPath: string): ShardInfo | null {
    return null;
  }

  deleteShard(_shardId: number): void {
    // No-op
  }
}

/**
 * PostgreSQL Database Adapter
 */
export class PostgresAdapter implements IDatabaseAdapter {
  private config: DatabaseConfig;
  private connectionManager: ConnectionManager;
  private vectorSearch: VectorSearch;
  private vectorSearchWrapper: PostgresVectorSearchWrapper | null = null;
  private shardManager: NoOpShardManager;
  private initialized = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.connectionManager = new ConnectionManager();
    this.vectorSearch = new VectorSearch();
    this.shardManager = new NoOpShardManager();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize connection pool and schema
    await this.connectionManager.getPool();
    this.vectorSearchWrapper = new PostgresVectorSearchWrapper(this.vectorSearch);
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.connectionManager.close();
    this.initialized = false;
    this.vectorSearchWrapper = null;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async healthCheck(): Promise<boolean> {
    return this.connectionManager.healthCheck();
  }

  getVectorSearch(): IVectorSearch {
    if (!this.vectorSearchWrapper) {
      throw new Error("PostgresAdapter not initialized. Call initialize() first.");
    }
    return this.vectorSearchWrapper;
  }

  getShardManager(): IShardManager {
    return this.shardManager;
  }
}
