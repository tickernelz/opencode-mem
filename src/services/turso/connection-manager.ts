import { connect, type Database } from "@tursodatabase/database";
import type { DatabaseOpts, EncryptionOpts } from "@tursodatabase/database-common";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { collectReleasedSqliteHandles } from "./sqlite-handle-release.js";
import { TursoDb } from "./turso-db.js";
import { resolveOrCreateDatabaseEncryptionKey } from "./encryption-key.js";
import {
  isWalIndexCorruptionError,
  quarantineWalSidecars,
  acquireRecoveryLock,
} from "./wal-index-recovery.js";

export type ConnectFactory = (path: string, opts?: DatabaseOpts) => Promise<Database>;

/** Always-on experimental flags for every Turso open. */
export const TURSO_BASE_EXPERIMENTAL_FEATURES = ["encryption"] as const;

/**
 * Multiprocess WAL is Unix-only. On Windows/WASM/32-bit the flag is accepted but
 * ignored (single-process mode) — see Turso multi-process docs.
 */
export function supportsTursoMultiprocessWal(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== "win32";
}

/**
 * Experimental flags required on every Turso open for the current platform.
 * `multiprocessWal: false` opts into single-owner mode (Unix), so a foreign
 * process gets a loud "database is locked" instead of silent divergence.
 */
export function tursoExperimentalFeatures(
  platform: NodeJS.Platform = process.platform,
  multiprocessWal: boolean = CONFIG.tursoMultiprocessWal
): Array<(typeof TURSO_BASE_EXPERIMENTAL_FEATURES)[number] | "multiprocess_wal"> {
  if (multiprocessWal && supportsTursoMultiprocessWal(platform)) {
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
  /**
   * Paths that already had a completed recovery attempt this process (no loop).
   * Set after a successful quarantine or a definitive skip — not when quarantine
   * moved nothing, so a later open can still finish a blocked first attempt.
   */
  private readonly healedPaths = new Set<string>();
  private readonly warnedForeignShmPaths = new Set<string>();

  constructor(private readonly connectFactory: ConnectFactory = connect) {}

  /**
   * Connect, and on a stale-WAL-index failure quarantine the index sidecars once
   * and retry once. Only the two known signatures heal (see #435); any other open
   * error propagates unchanged.
   *
   * Recovery is serialised across processes (they share `storagePath` through
   * `multiprocess_wal`) with `<storagePath>/recovery/<dbstem>.lock`. Under that
   * lock the open is re-attempted before any file is moved, so a peer that
   * healed first leaves us nothing to do. A non-empty WAL is never moved — see
   * `wal-index-recovery.ts` for the data-safety contract.
   */
  private async connectWithWalIndexRecovery(dbPath: string, opts: DatabaseOpts): Promise<Database> {
    try {
      return await this.connectFactory(dbPath, opts);
    } catch (error) {
      if (!CONFIG.tursoAutoHeal || !isWalIndexCorruptionError(error)) {
        throw error;
      }
      if (this.healedPaths.has(dbPath)) {
        throw error;
      }

      let lock: ReturnType<typeof acquireRecoveryLock>;
      try {
        lock = acquireRecoveryLock(dbPath);
      } catch (lockError) {
        log("Turso WAL index recovery skipped: could not take the recovery lock", {
          path: dbPath,
          error: String(lockError),
          originalError: String(error),
        });
        throw error;
      }
      if (!lock) {
        log("Turso WAL index recovery skipped: another process owns the recovery lock", {
          path: dbPath,
          hint: "The owning process is healing this store; leaving its files untouched.",
          error: String(error),
        });
        throw error;
      }
      if (lock.tookOverStaleLock) {
        log("Took over a stale Turso WAL index recovery lock", {
          path: dbPath,
          lock: lock.lockPath,
        });
      }

      try {
        // The peer may have healed between our failed open and taking the lock.
        try {
          const connection = await this.connectFactory(dbPath, opts);
          log("Turso open succeeded on the recovery-lock recheck; nothing was moved", {
            path: dbPath,
          });
          return connection;
        } catch (recheckError) {
          if (!isWalIndexCorruptionError(recheckError)) {
            // e.g. a lock error: do not move a live owner's files.
            log(
              "Turso recovery-lock recheck failed with an unrelated error; store left untouched",
              {
                path: dbPath,
                error: String(recheckError),
                originalError: String(error),
              }
            );
            throw error;
          }
        }

        const outcome = await quarantineWalSidecars(dbPath, this.connectFactory, opts);
        if (outcome.status === "failed") {
          log("Turso WAL index recovery failed; the store was left as-is where possible", {
            path: dbPath,
            reason: outcome.reason,
            quarantineDir: outcome.quarantineDir,
            moved: outcome.moved,
            error: String(error),
          });
          // A partial move (e.g. -tshm gone, -shm rename failed) may already be
          // enough to open. Retry once when anything moved; leave healedPaths
          // clear when nothing moved so a later attempt can finish the job.
          if (outcome.moved.length === 0) {
            throw error;
          }
          this.healedPaths.add(dbPath);
          try {
            return await this.connectFactory(dbPath, opts);
          } catch (retryError) {
            log("Turso open still failing after a partial WAL index recovery", {
              path: dbPath,
              quarantineDir: outcome.quarantineDir,
              moved: outcome.moved,
              error: String(retryError),
            });
            throw error;
          }
        }
        if (outcome.status === "skipped") {
          // Retrying the same path will not help (missing main file / bad copy /
          // nothing to move). Remember so we do not keep copying the database.
          this.healedPaths.add(dbPath);
          log("Turso open failed and the store was left untouched (no recovery attempted)", {
            path: dbPath,
            reason: outcome.reason,
            hint: "Restore this database from a backup; the sidecar files were not moved.",
            error: String(error),
          });
          throw error;
        }

        // Quarantine completed: mark before the retry so a still-corrupt store
        // cannot loop. Do not mark earlier — a mid-quarantine failure with
        // nothing useful moved must remain retryable in this process.
        this.healedPaths.add(dbPath);

        log("Moved stale WAL index sidecars aside after a Turso open failure; retrying once", {
          path: dbPath,
          quarantineDir: outcome.quarantineDir,
          moved: outcome.moved,
          removedEmptyWal: outcome.removedEmptyWal,
          retainedWalBytes: outcome.retainedWalBytes,
          hint:
            outcome.retainedWalBytes > 0
              ? "A non-empty -wal was kept; the engine rebuilds its index from it."
              : undefined,
        });

        try {
          return await this.connectFactory(dbPath, opts);
        } catch (retryError) {
          log("Turso open still failing after WAL index recovery", {
            path: dbPath,
            quarantineDir: outcome.quarantineDir,
            error: String(retryError),
            walPreserved: outcome.retainedWalBytes > 0,
            hint:
              outcome.retainedWalBytes > 0
                ? "The non-empty -wal was not moved, so no committed data was discarded."
                : "The -wal was empty or absent, so no committed data was discarded.",
          });
          throw error;
        }
      } finally {
        try {
          lock.release();
        } catch (releaseError) {
          try {
            log("Failed to release the Turso WAL index recovery lock", {
              path: dbPath,
              lock: lock.lockPath,
              error: String(releaseError),
            });
          } catch {
            // A logging failure must never replace the original open error.
          }
        }
      }
    }
  }

  /**
   * A foreign sqlite process that wrote this store leaves `-shm` next to a
   * Turso `-tshm`. Read-only access is harmless; a foreign writer diverges
   * silently and loses its own next write, so warn once per path. Never delete
   * `-shm` here — it may belong to a live reader.
   */
  private warnOnForeignSqliteShm(dbPath: string): void {
    if (this.warnedForeignShmPaths.has(dbPath)) return;
    if (!existsSync(`${dbPath}-shm`) || !existsSync(`${dbPath}-tshm`)) return;
    this.warnedForeignShmPaths.add(dbPath);
    log("Foreign SQLite process touched this store (-shm beside -tshm)", {
      path: dbPath,
      hint:
        "Read-only access is harmless, but a foreign writer silently loses data — " +
        "see issue #435. Close other tools on this store, or set tursoMultiprocessWal=false " +
        "for single-owner mode.",
    });
  }

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
        database = await this.connectWithWalIndexRecovery(dbPath, opts);
        const db = new TursoDb(database);
        await db.execute("PRAGMA foreign_keys = ON");
        this.warnOnForeignSqliteShm(dbPath);
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
