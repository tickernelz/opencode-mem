/**
 * Database adapter interfaces for SQLite and PostgreSQL
 */

import type { MemoryRecord, SearchResult, MemoryRow, DistinctTagRow } from "./types.js";

/**
 * Main database adapter interface
 */
export interface IDatabaseAdapter {
  /**
   * Initialize the database connection
   */
  initialize(): Promise<void>;

  /**
   * Close all database connections
   */
  close(): Promise<void>;

  /**
   * Check if the adapter is ready
   */
  isReady(): boolean;

  /**
   * Health check for the database connection
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get the vector search interface
   */
  getVectorSearch(): IVectorSearch;

  /**
   * Get the shard manager interface (SQLite only, no-op for PostgreSQL)
   */
  getShardManager(): IShardManager;
}

/**
 * Vector search operations interface
 */
export interface IVectorSearch {
  /**
   * Insert a memory record with vector embedding
   */
  insertMemory(record: MemoryRecord): Promise<void>;

  /**
   * Search memories by vector similarity
   */
  searchMemories(
    queryVector: number[],
    containerTag: string,
    limit: number,
    threshold: number,
    queryText?: string
  ): Promise<SearchResult[]>;

  /**
   * Delete a memory by ID
   */
  deleteMemory(memoryId: string): Promise<boolean>;

  /**
   * List memories by container tag
   */
  listMemories(containerTag: string, limit: number): Promise<MemoryRow[]>;

  /**
   * Get all memories
   */
  getAllMemories(): Promise<MemoryRow[]>;

  /**
   * Get a memory by ID
   */
  getMemoryById(memoryId: string): Promise<MemoryRow | null>;

  /**
   * Count memories by container tag
   */
  countMemories(containerTag: string): Promise<number>;

  /**
   * Count all memories
   */
  countAllMemories(): Promise<number>;

  /**
   * Get distinct tags
   */
  getDistinctTags(): Promise<DistinctTagRow[]>;

  /**
   * Pin a memory
   */
  pinMemory(memoryId: string): Promise<void>;

  /**
   * Unpin a memory
   */
  unpinMemory(memoryId: string): Promise<void>;
}

/**
 * Shard info for SQLite sharding
 */
export interface ShardInfo {
  id: number;
  scope: "user" | "project";
  scopeHash: string;
  shardIndex: number;
  dbPath: string;
  vectorCount: number;
  isActive: boolean;
  createdAt: number;
}

/**
 * Shard manager interface (SQLite specific, no-op for PostgreSQL)
 */
export interface IShardManager {
  /**
   * Get the active shard for a scope
   */
  getActiveShard(scope: "user" | "project", scopeHash: string): ShardInfo | null;

  /**
   * Get all shards for a scope
   */
  getAllShards(scope: "user" | "project", scopeHash: string): ShardInfo[];

  /**
   * Get the write shard for a scope (creates if not exists)
   */
  getWriteShard(scope: "user" | "project", scopeHash: string): ShardInfo;

  /**
   * Increment vector count for a shard
   */
  incrementVectorCount(shardId: number): void;

  /**
   * Decrement vector count for a shard
   */
  decrementVectorCount(shardId: number): void;

  /**
   * Get shard by database path
   */
  getShardByPath(dbPath: string): ShardInfo | null;

  /**
   * Delete a shard
   */
  deleteShard(shardId: number): void;
}
