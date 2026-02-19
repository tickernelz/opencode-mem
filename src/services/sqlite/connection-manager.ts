import { getDatabase } from "./sqlite-bootstrap.js";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.js";
import { CONFIG } from "../../config.js";

const Database = getDatabase();

export class ConnectionManager {
  private connections: Map<string, typeof Database.prototype> = new Map();

  private initDatabase(db: typeof Database.prototype): void {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -64000");
    db.run("PRAGMA temp_store = MEMORY");
    db.run("PRAGMA foreign_keys = ON");

    try {
      sqliteVec.load(db);
    } catch (error) {
      throw new Error(
        `Failed to load sqlite-vec extension: ${error}\n\n` +
          `This usually means SQLite extension loading is disabled.\n` +
          `On macOS, you must use Homebrew SQLite instead of Apple's SQLite.\n\n` +
          `Solution:\n` +
          `1. Install: brew install sqlite\n` +
          `2. Configure customSqlitePath in ~/.config/opencode/opencode-mem.jsonc`
      );
    }

    this.migrateSchema(db);
  }

  private migrateSchema(db: typeof Database.prototype): void {
    try {
      const columns = db.prepare("PRAGMA table_info(memories)").all() as any[];
      const hasTags = columns.some((c) => c.name === "tags");

      if (!hasTags && columns.length > 0) {
        db.run("ALTER TABLE memories ADD COLUMN tags TEXT");
      }

      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_tags USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
        )
      `);
    } catch (error) {
      log("Schema migration error", { error: String(error) });
    }
  }

  getConnection(dbPath: string): typeof Database.prototype {
    if (this.connections.has(dbPath)) {
      return this.connections.get(dbPath)!;
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new Database(dbPath);
    this.initDatabase(db);
    this.connections.set(dbPath, db);

    return db;
  }

  closeConnection(dbPath: string): void {
    const db = this.connections.get(dbPath);
    if (db) {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      this.connections.delete(dbPath);
    }
  }

  closeAll(): void {
    for (const [path, db] of this.connections) {
      try {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
      } catch (error) {
        log("Error closing database", { path, error: String(error) });
      }
    }
    this.connections.clear();
  }

  checkpointAll(): void {
    for (const [path, db] of this.connections) {
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        log("Error checkpointing database", { path, error: String(error) });
      }
    }
  }
}

export const connectionManager = new ConnectionManager();
