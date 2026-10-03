import { connect, type Database } from "@tursodatabase/database";
import type { DatabaseOpts, EncryptionOpts } from "@tursodatabase/database-common";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../../infra/logger.js";
import { collectReleasedSqliteHandles } from "./sqlite-handle-release.js";
import { TursoDb } from "./turso-db.js";
import { resolveOrCreateDatabaseEncryptionKey } from "./encryption-key.js";

export type ConnectFactory = (path: string, opts?: DatabaseOpts) => Promise<Database>;

/** Always-on experimental flags for every Turso open. */
export const TURSO_BASE_EXPERIMENTAL_FEATURES = ["encryption"] as const;

/**
 * Multiprocess WAL is Unix-only. On Windows the default IO backend rejects the
 * flag (`experimental multiprocess WAL is not supported by the active IO backend`).
 */
export function supportsTursoMultiprocessWal(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== "win32";
}

/** Experimental flags required on every Turso open for the current platform. */
export function tursoExperimentalFeatures(
  platform: NodeJS.Platform = process.platform
): Array<(typeof TURSO_BASE_EXPERIMENTAL_FEATURES)[number] | "multiprocess_wal"> {
  if (supportsTursoMultiprocessWal(platform)) {
    return [...TURSO_BASE_EXPERIMENTAL_FEATURES, "multiprocess_wal"];
  }
  return [...TURSO_BASE_EXPERIMENTAL_FEATURES];
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

/**
 * Shared connect options for `@tursodatabase/database`.
 * Always enables encryption; adds multiprocess_wal on Unix so concurrent
 * OpenCode sessions can share the store. Windows stays single-process.
 */
export function buildConnectOptions(encryption?: EncryptionOpts | null): DatabaseOpts {
  const opts: DatabaseOpts = {
    experimental: tursoExperimentalFeatures(),
  };
  if (encryption) {
    opts.encryption = encryption;
  }
  return opts;
}

export function resolveDatabaseEncryption(): EncryptionOpts | null {
  const hexkey = resolveOrCreateDatabaseEncryptionKey();
  if (!hexkey) return null;
  return {
    cipher: CONFIG.databaseEncryptionCipher,
    hexkey,
  };
}

const LOCK_ERROR_RE =
  /File is locked by another process|already open (with|without) experimental multiprocess WAL|Locking error/i;

export function isTursoMultiProcessLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return LOCK_ERROR_RE.test(message);
}

export function wrapTursoOpenError(dbPath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isTursoMultiProcessLockError(error)) {
    const platformHint =
      process.platform === "win32"
        ? "On Windows the Turso engine still allows only one process as database owner — close other OpenCode sessions."
        : "Another OpenCode session (or an older opencode-mem without multiprocess_wal) still holds the database — close it and retry.";
    return new Error(`Failed to open database ${dbPath}: ${message}. ${platformHint}`, {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error(message, { cause: error });
}

export class TursoConnectionManager {
  private readonly connections = new Map<string, TursoDb>();
  private readonly pending = new Map<string, Promise<TursoDb>>();
  private readonly closingConnections = new Map<string, Promise<void>>();
  private closingPromise: Promise<void> | null = null;

  constructor(private readonly connectFactory: ConnectFactory = connect) {}

  async getConnection(dbPath: string): Promise<TursoDb> {
    if (this.closingPromise) {
      await this.closingPromise;
    }
    const closingConnection = this.closingConnections.get(dbPath);
    if (closingConnection) {
      await closingConnection;
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

      const encryption = resolveDatabaseEncryption();
      const opts = buildConnectOptions(encryption);
      let database: Database | null = null;
      try {
        database = await this.connectFactory(dbPath, opts);
        const db = new TursoDb(database);
        await db.execute("PRAGMA foreign_keys = ON");
        this.connections.set(dbPath, db);
        return db;
      } catch (error) {
        if (database) {
          try {
            await database.close();
          } catch {
            // ignore close errors during cleanup
          }
        }
        if (encryption) {
          const message = error instanceof Error ? error.message : String(error);
          if (isTursoMultiProcessLockError(error)) {
            throw wrapTursoOpenError(dbPath, error);
          }
          throw new Error(
            `Failed to open encrypted database ${dbPath}: ${message}. ` +
              `Check databaseEncryptionKey / cipher, or remove encryption config for plaintext shards.`,
            { cause: error }
          );
        }
        throw wrapTursoOpenError(dbPath, error);
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
    if (this.closingPromise) {
      await this.closingPromise;
    }
    const existingClose = this.closingConnections.get(dbPath);
    if (existingClose) {
      return existingClose;
    }

    const closePromise = Promise.resolve()
      .then(async () => {
        const pending = this.pending.get(dbPath);
        if (pending) {
          await Promise.allSettled([pending]);
        }

        const db = this.connections.get(dbPath);
        if (db) {
          try {
            await db.close();
          } catch (error) {
            log("Error closing Turso database", { path: dbPath, error: String(error) });
          }

          this.connections.delete(dbPath);
        }

        await collectReleasedSqliteHandles();
      })
      .finally(() => {
        this.closingConnections.delete(dbPath);
      });

    this.closingConnections.set(dbPath, closePromise);
    return closePromise;
  }

  async closeAll(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;

    this.closingPromise = (async () => {
      await Promise.allSettled([...this.pending.values(), ...this.closingConnections.values()]);
      for (const [path, db] of this.connections) {
        try {
          await db.close();
        } catch (error) {
          log("Error closing Turso database", { path, error: String(error) });
        }
      }
      this.connections.clear();
      this.pending.clear();
      await collectReleasedSqliteHandles();
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
        void db.close();
      } catch (error) {
        log("Error closing Turso database (sync)", { path, error: String(error) });
      }
    }
    this.connections.clear();
    this.pending.clear();
  }
}

export const tursoConnectionManager = new TursoConnectionManager();
