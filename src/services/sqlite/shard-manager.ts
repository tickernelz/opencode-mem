import { Database } from "bun:sqlite";
import { join, basename, isAbsolute } from "node:path";
import { CONFIG } from "../../config.js";
import { connectionManager } from "./connection-manager.js";
import { log } from "../logger.js";
import type { ShardInfo } from "./types.js";

const METADATA_DB_NAME = "metadata.db";

export class ShardManager {
  private metadataDb: Database;
  private metadataPath: string;

  constructor() {
    this.metadataPath = join(CONFIG.storagePath, METADATA_DB_NAME);
    this.metadataDb = connectionManager.getConnection(this.metadataPath);
    this.initMetadataDb();
  }

  private initMetadataDb(): void {
    this.metadataDb.run(`
      CREATE TABLE IF NOT EXISTS shards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        shard_index INTEGER NOT NULL,
        db_path TEXT NOT NULL,
        vector_count INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(scope, scope_hash, shard_index)
      )
    `);

    this.metadataDb.run(`
      CREATE INDEX IF NOT EXISTS idx_active_shards 
      ON shards(scope, scope_hash, is_active)
    `);
  }

  private getShardPath(scope: "user" | "project", scopeHash: string, shardIndex: number): string {
    const dir = join(CONFIG.storagePath, `${scope}s`);
    return join(dir, `${scope}_${scopeHash}_shard_${shardIndex}.db`);
  }

  private resolveStoredPath(storedPath: string, scope: string): string {
    const fileName = basename(storedPath);
    return join(CONFIG.storagePath, `${scope}s`, fileName);
  }

  getActiveShard(scope: "user" | "project", scopeHash: string): ShardInfo | null {
    const stmt = this.metadataDb.prepare(`
      SELECT * FROM shards 
      WHERE scope = ? AND scope_hash = ? AND is_active = 1
      ORDER BY shard_index DESC LIMIT 1
    `);

    const row = stmt.get(scope, scopeHash) as any;
    if (!row) return null;

    return {
      id: row.id,
      scope: row.scope,
      scopeHash: row.scope_hash,
      shardIndex: row.shard_index,
      dbPath: this.resolveStoredPath(row.db_path, row.scope),
      vectorCount: row.vector_count,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  getAllShards(scope: "user" | "project", scopeHash: string): ShardInfo[] {
    let stmt;
    let rows;

    if (scopeHash === "") {
      stmt = this.metadataDb.prepare(`
        SELECT * FROM shards 
        WHERE scope = ?
        ORDER BY shard_index ASC
      `);
      rows = stmt.all(scope) as any[];
    } else {
      stmt = this.metadataDb.prepare(`
        SELECT * FROM shards 
        WHERE scope = ? AND scope_hash = ?
        ORDER BY shard_index ASC
      `);
      rows = stmt.all(scope, scopeHash) as any[];
    }

    return rows.map((row: any) => ({
      id: row.id,
      scope: row.scope,
      scopeHash: row.scope_hash,
      shardIndex: row.shard_index,
      dbPath: this.resolveStoredPath(row.db_path, row.scope),
      vectorCount: row.vector_count,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    }));
  }

  createShard(scope: "user" | "project", scopeHash: string, shardIndex: number): ShardInfo {
    const fullPath = this.getShardPath(scope, scopeHash, shardIndex);
    const storedPath = join(`${scope}s`, basename(fullPath)).replace(/\\/g, "/");
    const now = Date.now();

    const stmt = this.metadataDb.prepare(`
      INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
      VALUES (?, ?, ?, ?, 0, 1, ?)
    `);

    const result = stmt.run(scope, scopeHash, shardIndex, storedPath, now);

    const db = connectionManager.getConnection(fullPath);
    this.initShardDb(db);

    return {
      id: Number(result.lastInsertRowid),
      scope,
      scopeHash,
      shardIndex,
      dbPath: fullPath,
      vectorCount: 0,
      isActive: true,
      createdAt: now,
    };
  }

  private initShardDb(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS shard_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    db.run(`
      INSERT OR REPLACE INTO shard_metadata (key, value) 
      VALUES ('embedding_dimensions', '${CONFIG.embeddingDimensions}')
    `);

    db.run(`
      INSERT OR REPLACE INTO shard_metadata (key, value) 
      VALUES ('embedding_model', '${CONFIG.embeddingModel}')
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        vector BLOB NOT NULL,
        container_tag TEXT NOT NULL,
        tags TEXT,
        type TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT,
        display_name TEXT,
        user_name TEXT,
        user_email TEXT,
        project_path TEXT,
        project_name TEXT,
        git_repo_url TEXT,
        is_pinned INTEGER DEFAULT 0
      )
    `);

    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
      )
    `);

    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_tags USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
      )
    `);

    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        container_tag UNINDEXED,
        memory_id UNINDEXED,
        tokenize='porter unicode61'
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_type ON memories(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_is_pinned ON memories(is_pinned)`);
  }

  getWriteShard(scope: "user" | "project", scopeHash: string): ShardInfo {
    let shard = this.getActiveShard(scope, scopeHash);

    if (!shard) {
      return this.createShard(scope, scopeHash, 0);
    }

    if (shard.vectorCount >= CONFIG.maxVectorsPerShard) {
      this.markShardReadOnly(shard.id);
      return this.createShard(scope, scopeHash, shard.shardIndex + 1);
    }

    return shard;
  }

  private markShardReadOnly(shardId: number): void {
    const stmt = this.metadataDb.prepare(`
      UPDATE shards SET is_active = 0 WHERE id = ?
    `);
    stmt.run(shardId);
  }

  incrementVectorCount(shardId: number): void {
    const stmt = this.metadataDb.prepare(`
      UPDATE shards SET vector_count = vector_count + 1 WHERE id = ?
    `);
    stmt.run(shardId);
  }

  decrementVectorCount(shardId: number): void {
    const stmt = this.metadataDb.prepare(`
      UPDATE shards SET vector_count = vector_count - 1 WHERE id = ? AND vector_count > 0
    `);
    stmt.run(shardId);
  }

  getShardByPath(dbPath: string): ShardInfo | null {
    const fileName = basename(dbPath);
    const stmt = this.metadataDb.prepare(`SELECT * FROM shards WHERE db_path LIKE '%' || ?`);
    const row = stmt.get(fileName) as any;
    if (!row) return null;

    return {
      id: row.id,
      scope: row.scope,
      scopeHash: row.scope_hash,
      shardIndex: row.shard_index,
      dbPath: this.resolveStoredPath(row.db_path, row.scope),
      vectorCount: row.vector_count,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  deleteShard(shardId: number): void {
    const stmt = this.metadataDb.prepare(`SELECT * FROM shards WHERE id = ?`);
    const row = stmt.get(shardId) as any;

    if (row) {
      const fullPath = this.resolveStoredPath(row.db_path, row.scope);
      connectionManager.closeConnection(fullPath);

      try {
        const fs = require("node:fs");
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (error) {
        log("Error deleting shard file", { dbPath: fullPath, error: String(error) });
      }

      const deleteStmt = this.metadataDb.prepare(`DELETE FROM shards WHERE id = ?`);
      deleteStmt.run(shardId);
    }
  }
}

export const shardManager = new ShardManager();
