import { createClient, type Client } from "@libsql/client";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { TursoDb } from "./turso-db.js";

function toFileUrl(dbPath: string): string {
  return dbPath.startsWith("file:") ? dbPath : `file:${dbPath}`;
}

function assertPathInsideStorage(dbPath: string): void {
  const storageRoot = resolve(CONFIG.storagePath);
  const resolvedPath = resolve(dbPath);
  const relativePath = relative(storageRoot, resolvedPath);
  // Only treat path-segment traversal as escape (not filenames containing "..").
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Refusing to open database outside storagePath: ${dbPath}`);
  }
}

export class TursoConnectionManager {
  private readonly connections = new Map<string, TursoDb>();
  private readonly pending = new Map<string, Promise<TursoDb>>();
  private closingPromise: Promise<void> | null = null;

  async getConnection(dbPath: string): Promise<TursoDb> {
    if (this.closingPromise) {
      await this.closingPromise;
    }
    assertPathInsideStorage(dbPath);

    const existing = this.connections.get(dbPath);
    if (existing) {
      return existing;
    }

    const inFlight = this.pending.get(dbPath);
    if (inFlight) {
      return inFlight;
    }

    const openPromise = (async (): Promise<TursoDb> => {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const client: Client = createClient({ url: toFileUrl(dbPath) });
      try {
        const db = new TursoDb(client);
        await db.execute("PRAGMA foreign_keys = ON");
        this.connections.set(dbPath, db);
        return db;
      } catch (error) {
        try {
          client.close();
        } catch {
          // ignore close errors during cleanup
        }
        throw error;
      }
    })();

    this.pending.set(dbPath, openPromise);

    try {
      return await openPromise;
    } catch (error) {
      this.connections.delete(dbPath);
      throw error;
    } finally {
      this.pending.delete(dbPath);
    }
  }

  async closeConnection(dbPath: string): Promise<void> {
    const db = this.connections.get(dbPath);
    if (!db) return;

    try {
      await db.close();
    } catch (error) {
      log("Error closing Turso database", { path: dbPath, error: String(error) });
    }

    this.connections.delete(dbPath);
  }

  async closeAll(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;

    this.closingPromise = (async () => {
      await Promise.allSettled(this.pending.values());
      for (const [path, db] of this.connections) {
        try {
          await db.close();
        } catch (error) {
          log("Error closing Turso database", { path, error: String(error) });
        }
      }
      this.connections.clear();
      this.pending.clear();
    })();

    try {
      await this.closingPromise;
    } finally {
      this.closingPromise = null;
    }
  }

  closeAllSync(): void {
    for (const [path, db] of this.connections) {
      try {
        db.getClient().close();
      } catch (error) {
        log("Error closing Turso database (sync)", { path, error: String(error) });
      }
    }
    this.connections.clear();
    this.pending.clear();
  }
}

export const tursoConnectionManager = new TursoConnectionManager();
