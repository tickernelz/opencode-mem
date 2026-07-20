import { join, basename, resolve, relative } from "node:path";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { CONFIG } from "../../config.js";
import { assertSafeScopeHash } from "../memory-scope.js";
import { tursoConnectionManager } from "./connection-manager.js";
import { log } from "../logger.js";
import { assertNoTursoMigrationInProgress } from "./operation-lock.js";
import type { ShardInfo } from "./types.js";
import type { TursoDb } from "./turso-db.js";

const METADATA_DB_NAME = "metadata.db";

function getValidatedEmbeddingDimensions(dimensions = CONFIG.embeddingDimensions): number {
  const dims = dimensions;
  if (!Number.isInteger(dims) || dims <= 0 || dims > 65536) {
    throw new Error(`Invalid embeddingDimensions config: ${dims}`);
  }
  return dims;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT");
}

export class TursoShardManager {
  private metadataDb: TursoDb | null = null;
  private metadataPath = "";
  private initPromise: Promise<void> | null = null;
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  reset(): void {
    this.metadataDb = null;
    this.initPromise = null;
    this.metadataPath = "";
    this.writeLocks.clear();
  }

  async withScopeWriteLock<T>(
    scope: "user" | "project",
    scopeHash: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${scope}:${scopeHash}`;
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.writeLocks.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  private async ensureInitialized(): Promise<TursoDb> {
    if (this.metadataDb && this.initPromise) {
      await this.initPromise;
      return this.metadataDb;
    }

    if (this.initPromise) {
      await this.initPromise;
      if (this.metadataDb) return this.metadataDb;
    }

    this.initPromise = (async () => {
      try {
        this.metadataPath = join(CONFIG.storagePath, METADATA_DB_NAME);
        this.metadataDb = await tursoConnectionManager.getConnection(this.metadataPath);
        await this.initMetadataDb(this.metadataDb);
      } catch (error) {
        this.initPromise = null;
        this.metadataDb = null;
        throw error;
      }
    })();

    await this.initPromise;
    return this.metadataDb!;
  }

  private async initMetadataDb(db: TursoDb): Promise<void> {
    await db.batch([
      {
        sql: `
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
        `,
      },
      {
        sql: `
          CREATE INDEX IF NOT EXISTS idx_active_shards
          ON shards(scope, scope_hash, is_active)
        `,
      },
    ]);
  }

  private getShardPath(scope: "user" | "project", scopeHash: string, shardIndex: number): string {
    assertSafeScopeHash(scopeHash);
    const scopeDir = resolve(CONFIG.storagePath, `${scope}s`);
    const fullPath = resolve(join(scopeDir, `${scope}_${scopeHash}_shard_${shardIndex}.db`));
    const relativePath = relative(scopeDir, fullPath);
    if (relativePath.startsWith("..") || relativePath.includes("..")) {
      throw new Error(`Shard path escapes storage directory: ${fullPath}`);
    }
    return fullPath;
  }

  private resolveStoredPath(storedPath: string, scope: string): string {
    const fileName = basename(storedPath);
    return join(CONFIG.storagePath, `${scope}s`, fileName);
  }

  async getActiveShard(scope: "user" | "project", scopeHash: string): Promise<ShardInfo | null> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(
      `
      SELECT * FROM shards
      WHERE scope = ? AND scope_hash = ? AND is_active = 1
      ORDER BY shard_index DESC LIMIT 1
    `,
      [scope, scopeHash]
    );

    if (!row) return null;
    return this.rowToShardInfo(row);
  }

  async getAllShards(scope: "user" | "project", scopeHash: string): Promise<ShardInfo[]> {
    const metadataDb = await this.ensureInitialized();
    const rows =
      scopeHash === ""
        ? await metadataDb.all(
            `
          SELECT * FROM shards
          WHERE scope = ?
          ORDER BY shard_index ASC
        `,
            [scope]
          )
        : await metadataDb.all(
            `
          SELECT * FROM shards
          WHERE scope = ? AND scope_hash = ?
          ORDER BY shard_index ASC
        `,
            [scope, scopeHash]
          );

    return rows.map((row) => this.rowToShardInfo(row));
  }

  async createShard(
    scope: "user" | "project",
    scopeHash: string,
    shardIndex: number
  ): Promise<ShardInfo> {
    const metadataDb = await this.ensureInitialized();
    const fullPath = this.getShardPath(scope, scopeHash, shardIndex);
    const storedPath = join(`${scope}s`, basename(fullPath)).replace(/\\/g, "/");
    const now = Date.now();

    let result;
    try {
      result = await metadataDb.execute(
        `
      INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
      VALUES (?, ?, ?, ?, 0, 1, ?)
    `,
        [scope, scopeHash, shardIndex, storedPath, now]
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await metadataDb.get(
          `
          SELECT * FROM shards
          WHERE scope = ? AND scope_hash = ? AND shard_index = ?
        `,
          [scope, scopeHash, shardIndex]
        );
        if (existing) {
          return this.rowToShardInfo(existing);
        }
      }
      throw error;
    }

    const shardDb = await tursoConnectionManager.getConnection(fullPath);
    await this.initShardDb(shardDb);

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

  async registerExistingShard(
    scope: "user" | "project",
    scopeHash: string,
    shardIndex: number,
    dbPath: string,
    vectorCount: number,
    isActive: boolean
  ): Promise<ShardInfo> {
    assertSafeScopeHash(scopeHash);
    const metadataDb = await this.ensureInitialized();
    const storedPath = join(`${scope}s`, basename(dbPath)).replace(/\\/g, "/");
    const now = Date.now();

    await metadataDb.execute(
      `
        INSERT INTO shards (
          scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, scope_hash, shard_index) DO UPDATE SET
          db_path = excluded.db_path,
          vector_count = excluded.vector_count,
          is_active = excluded.is_active
      `,
      [scope, scopeHash, shardIndex, storedPath, vectorCount, isActive ? 1 : 0, now]
    );

    const row = await metadataDb.get(
      `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? AND shard_index = ?`,
      [scope, scopeHash, shardIndex]
    );
    if (!row) {
      throw new Error(`Failed to register shard ${scope}/${scopeHash}#${shardIndex}`);
    }
    return this.rowToShardInfo(row);
  }

  async initShardDb(
    db: TursoDb,
    dimensions = CONFIG.embeddingDimensions,
    embeddingModel = CONFIG.embeddingModel
  ): Promise<void> {
    const dims = getValidatedEmbeddingDimensions(dimensions);

    await db.batch([
      {
        sql: `
          CREATE TABLE IF NOT EXISTS shard_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `,
      },
      {
        sql: `
          INSERT OR REPLACE INTO shard_metadata (key, value)
          VALUES ('embedding_dimensions', ?)
        `,
        args: [String(dims)],
      },
      {
        sql: `
          INSERT OR REPLACE INTO shard_metadata (key, value)
          VALUES ('embedding_model', ?)
        `,
        args: [embeddingModel],
      },
      {
        sql: `
          CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            vector F32_BLOB(${dims}) NOT NULL,
            tags_vector F32_BLOB(${dims}),
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
        `,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)`,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS idx_type ON memories(type)`,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)`,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS idx_is_pinned ON memories(is_pinned)`,
      },
      {
        sql: `
          CREATE INDEX IF NOT EXISTS memories_vec_idx
          ON memories (libsql_vector_idx(vector, 'metric=cosine'))
        `,
      },
      {
        sql: `
          CREATE INDEX IF NOT EXISTS memories_tags_vec_idx
          ON memories (libsql_vector_idx(tags_vector, 'metric=cosine'))
          WHERE tags_vector IS NOT NULL
        `,
      },
    ]);
  }

  private rowToShardInfo(row: Record<string, unknown>): ShardInfo {
    return {
      id: Number(row.id),
      scope: row.scope as "user" | "project",
      scopeHash: String(row.scope_hash),
      shardIndex: Number(row.shard_index),
      dbPath: this.resolveStoredPath(String(row.db_path), String(row.scope)),
      vectorCount: Number(row.vector_count),
      isActive: Number(row.is_active) === 1,
      createdAt: Number(row.created_at),
    };
  }

  private async hasMatchingEmbeddingDimensions(db: TursoDb, shard: ShardInfo): Promise<boolean> {
    const row = await db.get(`SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`);
    if (!row?.value) {
      log("Shard missing embedding_dimensions metadata", {
        dbPath: shard.dbPath,
        shardId: shard.id,
      });
      return false;
    }

    const storedDimensions = Number(row.value);
    if (storedDimensions !== getValidatedEmbeddingDimensions()) {
      log("Shard embedding dimensions mismatch", {
        dbPath: shard.dbPath,
        shardId: shard.id,
        storedDimensions,
        configDimensions: CONFIG.embeddingDimensions,
      });
      return false;
    }

    return true;
  }

  private async syncShardVectorCount(shard: ShardInfo): Promise<ShardInfo> {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const row = await db.get(`SELECT COUNT(*) as count FROM memories`);
    const count = Number(row?.count ?? 0);

    if (count === shard.vectorCount) {
      return shard;
    }

    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET vector_count = ? WHERE id = ?`, [count, shard.id]);
    return { ...shard, vectorCount: count };
  }

  private async isShardValid(shard: ShardInfo): Promise<boolean> {
    if (!existsSync(shard.dbPath)) {
      log("Shard DB file missing", { dbPath: shard.dbPath, shardId: shard.id });
      return false;
    }

    try {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const result = await db.get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`
      );
      if (!result) {
        log("Shard DB missing 'memories' table", {
          dbPath: shard.dbPath,
          shardId: shard.id,
        });
        return false;
      }

      if (!(await this.hasMatchingEmbeddingDimensions(db, shard))) {
        return false;
      }

      return true;
    } catch (error) {
      log("Error validating shard DB", {
        dbPath: shard.dbPath,
        error: String(error),
      });
      return false;
    }
  }

  async getWriteShard(scope: "user" | "project", scopeHash: string): Promise<ShardInfo> {
    assertNoTursoMigrationInProgress();
    for (let attempt = 0; attempt < 3; attempt++) {
      let shard = await this.getActiveShard(scope, scopeHash);

      if (!shard) {
        return this.createShard(scope, scopeHash, 0);
      }

      if (!(await this.isShardValid(shard))) {
        throw new Error(
          `Shard ${shard.scope}/${shard.scopeHash}#${shard.shardIndex} is incompatible or corrupt. ` +
            `The original database was left untouched at ${shard.dbPath}; run the migration or restore it before writing.`
        );
      }

      shard = await this.syncShardVectorCount(shard);

      if (shard.vectorCount >= CONFIG.maxVectorsPerShard) {
        await this.markShardReadOnly(shard.id);
        return this.createShard(scope, scopeHash, shard.shardIndex + 1);
      }

      return shard;
    }

    throw new Error(`Failed to resolve write shard for ${scope}/${scopeHash}`);
  }

  private async markShardReadOnly(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET is_active = 0 WHERE id = ?`, [shardId]);
  }

  async incrementVectorCount(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET vector_count = vector_count + 1 WHERE id = ?`, [
      shardId,
    ]);
  }

  async decrementVectorCount(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(
      `UPDATE shards SET vector_count = vector_count - 1 WHERE id = ? AND vector_count > 0`,
      [shardId]
    );
  }

  async setVectorCount(shardId: number, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid vector count: ${count}`);
    }
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET vector_count = ? WHERE id = ?`, [count, shardId]);
  }

  async getShardById(shardId: number): Promise<ShardInfo | null> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    return row ? this.rowToShardInfo(row) : null;
  }

  async getShardByPath(dbPath: string): Promise<ShardInfo | null> {
    const metadataDb = await this.ensureInitialized();
    const fileName = basename(dbPath);
    const row = await metadataDb.get(`SELECT * FROM shards WHERE db_path LIKE '%' || ?`, [
      fileName,
    ]);
    if (!row) return null;
    return this.rowToShardInfo(row);
  }

  async deleteShard(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);

    if (!row) return;

    const fullPath = this.resolveStoredPath(String(row.db_path), String(row.scope));
    await tursoConnectionManager.closeConnection(fullPath);

    try {
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    } catch (error) {
      log("Error deleting shard file", {
        dbPath: fullPath,
        error: String(error),
      });
    }

    await metadataDb.run(`DELETE FROM shards WHERE id = ?`, [shardId]);
  }

  async archiveShard(shardId: number, reason: string): Promise<string | null> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!row) return null;

    const fullPath = this.resolveStoredPath(String(row.db_path), String(row.scope));
    await tursoConnectionManager.closeConnection(fullPath);
    const archivePath = `${fullPath}.${reason}-${process.pid}-${Date.now()}.bak`;

    if (existsSync(fullPath)) {
      renameSync(fullPath, archivePath);
    }
    try {
      await metadataDb.run(`DELETE FROM shards WHERE id = ?`, [shardId]);
    } catch (error) {
      if (existsSync(archivePath) && !existsSync(fullPath)) {
        renameSync(archivePath, fullPath);
      }
      throw error;
    }
    return existsSync(archivePath) ? archivePath : null;
  }
}

export const tursoShardManager = new TursoShardManager();
