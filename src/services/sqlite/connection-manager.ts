import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../logger.js";

export class ConnectionManager {
  private connections: Map<string, Database> = new Map();

  private initDatabase(db: Database): void {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -64000");
    db.run("PRAGMA temp_store = MEMORY");
    db.run("PRAGMA foreign_keys = ON");
    
    sqliteVec.load(db);
  }

  getConnection(dbPath: string): Database {
    if (this.connections.has(dbPath)) {
      return this.connections.get(dbPath)!;
    }

    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const db = new Database(dbPath);
    this.initDatabase(db);
    this.connections.set(dbPath, db);
    
    log("SQLite connection opened", { path: dbPath });
    return db;
  }

  closeConnection(dbPath: string): void {
    const db = this.connections.get(dbPath);
    if (db) {
      db.close();
      this.connections.delete(dbPath);
      log("SQLite connection closed", { path: dbPath });
    }
  }

  closeAll(): void {
    for (const [path, db] of this.connections) {
      db.close();
      log("SQLite connection closed", { path });
    }
    this.connections.clear();
  }
}

export const connectionManager = new ConnectionManager();
