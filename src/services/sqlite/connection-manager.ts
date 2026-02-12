import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.js";
import { CONFIG } from "../../config.js";

export class ConnectionManager {
  private connections: Map<string, Database> = new Map();
  private sqliteConfigured = false;

  private configureSqlite(): void {
    if (this.sqliteConfigured) return;

    if (process.platform === "darwin") {
      const customPath = CONFIG.customSqlitePath;

      if (customPath) {
        if (!existsSync(customPath)) {
          throw new Error(
            `Custom SQLite library not found at: ${customPath}\n` +
              `Please verify the path or install Homebrew SQLite:\n` +
              `  brew install sqlite\n` +
              `  brew --prefix sqlite`
          );
        }

        try {
          Database.setCustomSQLite(customPath);
        } catch (error) {
          const errorStr = String(error);
          if (errorStr.includes("SQLite already loaded")) {
          } else {
            throw new Error(
              `Failed to load custom SQLite library: ${error}\n` + `Path: ${customPath}`
            );
          }
        }
      } else {
        const commonPaths = [
          "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
          "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
        ];

        let foundPath: string | null = null;
        for (const path of commonPaths) {
          if (existsSync(path)) {
            foundPath = path;
            break;
          }
        }

        if (foundPath) {
          try {
            Database.setCustomSQLite(foundPath);
          } catch (error) {
            const errorStr = String(error);
            if (errorStr.includes("SQLite already loaded")) {
            } else {
              throw new Error(`Failed to load Homebrew SQLite: ${error}\n` + `Path: ${foundPath}`);
            }
          }
        } else {
          throw new Error(
            `macOS detected but no compatible SQLite library found.\n\n` +
              `Apple's default SQLite does not support extension loading.\n` +
              `Please install Homebrew SQLite and configure the path:\n\n` +
              `1. Install Homebrew SQLite:\n` +
              `   brew install sqlite\n\n` +
              `2. Find the library path:\n` +
              `   brew --prefix sqlite\n\n` +
              `3. Add to ~/.config/opencode/opencode-mem.jsonc:\n` +
              `   {\n` +
              `     "customSqlitePath": "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"\n` +
              `   }\n\n` +
              `Common paths:\n` +
              `  - Apple Silicon: /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib\n` +
              `  - Intel Mac:     /usr/local/opt/sqlite/lib/libsqlite3.dylib`
          );
        }
      }
    }

    this.sqliteConfigured = true;
  }

  private initDatabase(db: Database): void {
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

  private migrateSchema(db: Database): void {
    try {
      const columns = db.prepare("PRAGMA table_info(memories)").all() as any[];
      const hasTags = columns.some((c) => c.name === "tags");
      const hasMemoriesTable = columns.length > 0;

      if (!hasTags && hasMemoriesTable) {
        db.run("ALTER TABLE memories ADD COLUMN tags TEXT");
      }

      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_tags USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float32[${CONFIG.embeddingDimensions}] distance_metric=cosine
        )
      `);

      if (hasMemoriesTable) {
        const hasFtsTable = Boolean(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'")
            .get()
        );

        db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content,
            tags,
            container_tag UNINDEXED,
            memory_id UNINDEXED,
            tokenize='porter unicode61'
          )
        `);

        if (!hasFtsTable) {
          db.run(`
            INSERT INTO memories_fts(content, tags, container_tag, memory_id)
            SELECT content, COALESCE(tags, ''), container_tag, id
            FROM memories
          `);
        }
      }
    } catch (error) {
      log("Schema migration error", { error: String(error) });
    }
  }

  getConnection(dbPath: string): Database {
    if (this.connections.has(dbPath)) {
      return this.connections.get(dbPath)!;
    }

    this.configureSqlite();

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
