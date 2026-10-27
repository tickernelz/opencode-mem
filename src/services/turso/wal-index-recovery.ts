import type { Database } from "@tursodatabase/database";
import type { DatabaseOpts } from "@tursodatabase/database-common";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import type { ConnectFactory } from "./connection-manager.js";

/**
 * Turso keeps its multiprocess WAL index in `<db>-tshm`; stock sqlite uses
 * `<db>-shm`. A `-tshm` (or `-shm`) that outlives the WAL it indexes makes the
 * next open fail with one of these two errors (see issue #435):
 *   - "I/O error: short read on WAL frame at offset N: expected 4096 bytes, got 0"
 *   - "Corrupt database: Invalid page type: 0"
 *
 * Recovery contract — what this module does, and what it does not promise:
 *   - Only the *index* sidecars `-shm` and `-tshm` are moved aside. A `-wal` is
 *     removed only when it is absent or 0 bytes. A non-empty `-wal` is left in
 *     place: committed transactions can live only in the WAL, and a copy of the
 *     main `.db` alone can still pass `PRAGMA integrity_check`. Discarding such
 *     a WAL would silently roll the store back to an older snapshot.
 *   - With the index gone, the engine rebuilds `-tshm` from the surviving WAL on
 *     the next open. That is measured, not assumed: this repo's test seeds a real
 *     database, leaves committed rows only in the WAL, discards `-tshm` and reads
 *     the rows back through the real engine (Linux x64,
 *     `@tursodatabase/database` 0.8.3). It is still engine behaviour rather than
 *     an API this repository controls. A *torn* WAL (partial final frame) is not
 *     covered: then the retry fails, the original open error is surfaced, and the
 *     WAL is left untouched, so no committed data is lost.
 *   - A copy of the main `.db` (never the live file) must pass
 *     `PRAGMA integrity_check` first. That is a sanity gate only — it says
 *     nothing about the WAL's consistency.
 *   - Recovery is serialised across processes with
 *     `<storagePath>/recovery/<dbstem>.lock`. A process that cannot take the
 *     lock leaves the store alone rather than racing the owner.
 *   - A failure while quarantining is reported, never substituted for the
 *     original open error.
 */
const WAL_INDEX_CORRUPTION_PATTERNS = [
  /short read on WAL frame at offset \d+/i,
  /invalid page type:\s*0\b/i,
];

/**
 * Index sidecars that are moved aside. The WAL itself is handled separately.
 * `-tshm` is moved first: it is the Turso index that blocks open, so a partial
 * quarantine that stops after the first rename is more likely to already heal.
 */
export const WAL_INDEX_SIDECAR_SUFFIXES = ["-tshm", "-shm"] as const;
export const WAL_FILE_SUFFIX = "-wal";

/** A lock older than this is assumed to belong to a crashed healer. */
export const RECOVERY_LOCK_STALE_MS = 5 * 60 * 1000;

/** True for the two "stale WAL index" open failures that self-heal can repair. */
export function isWalIndexCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return WAL_INDEX_CORRUPTION_PATTERNS.some((pattern) => pattern.test(message));
}

export type WalIndexRecoveryResult =
  | {
      status: "quarantined";
      quarantineDir: string | null;
      moved: string[];
      removedEmptyWal: boolean;
      retainedWalBytes: number;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; quarantineDir: string | null; moved: string[] };

export interface RecoveryLock {
  lockPath: string;
  /** True when the previous owner's lock looked abandoned and was replaced. */
  tookOverStaleLock: boolean;
  /** Idempotent, never throws. */
  release(): void;
}

function recoveryRoot(): string {
  return join(CONFIG.storagePath, "recovery");
}

export function recoveryLockPathFor(dbPath: string): string {
  const stem = basename(dbPath, extname(dbPath));
  return join(recoveryRoot(), `${stem}.lock`);
}

function quarantineDirFor(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = basename(dbPath, extname(dbPath));
  return join(recoveryRoot(), `${stem}-${stamp}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > RECOVERY_LOCK_STALE_MS;
  } catch {
    // Vanished between EEXIST and stat: retry the atomic create instead.
    return true;
  }
}

/**
 * Take the per-database recovery lock, or return null when a live process owns
 * it. The lock file is created with `O_EXCL`, so two healers can never both win.
 * A lock whose mtime is older than `RECOVERY_LOCK_STALE_MS` is treated as a
 * crashed healer's and taken over (reported via `tookOverStaleLock`).
 */
export function acquireRecoveryLock(dbPath: string): RecoveryLock | null {
  const lockPath = recoveryLockPathFor(dbPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  let tookOverStaleLock = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } catch {
        // Owner metadata is advisory only; the lock is still held.
      }
      let released = false;
      return {
        lockPath,
        tookOverStaleLock,
        release() {
          if (released) return;
          released = true;
          try {
            closeSync(fd);
          } catch {
            // ignore: fd may already be gone
          }
          try {
            rmSync(lockPath, { force: true });
          } catch {
            // ignore: a stale lock file is recoverable, a thrown error is not
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (attempt > 0 || !isStaleLock(lockPath)) {
        return null;
      }
      tookOverStaleLock = true;
      // Atomic rename, not unlink: only one process can move the stale inode,
      // so two healers cannot both delete-then-create and end up sharing it.
      const stalePath = `${lockPath}.${process.pid}.stale`;
      try {
        renameSync(lockPath, stalePath);
        rmSync(stalePath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Verify a copy of the main database file. The live file is never opened with a
 * different engine — that is what produces the "Invalid page type: 0" class.
 *
 * Any failure here (temp dir, copy, close) is contained: it reports "unhealthy"
 * rather than throwing, so the caller can keep rethrowing the original error.
 */
async function isCopiedDatabaseHealthy(
  dbPath: string,
  connectFactory: ConnectFactory,
  opts: DatabaseOpts
): Promise<boolean> {
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-mem-wal-check-"));
    const copyPath = join(tempDir, basename(dbPath));
    copyFileSync(dbPath, copyPath);
    let database: Database | null = null;
    try {
      database = await connectFactory(copyPath, opts);
      const rows: unknown = await database.all("PRAGMA integrity_check");
      const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : null;
      const value = first ? Object.values(first)[0] : undefined;
      return String(value ?? "").toLowerCase() === "ok";
    } finally {
      if (database) {
        try {
          await database.close();
        } catch {
          // ignore close errors on a throwaway copy
        }
      }
    }
  } catch (error) {
    log("Turso WAL index recovery: could not verify a copy of the database", {
      path: dbPath,
      error: String(error),
    });
    return false;
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Temp-dir leftovers are harmless; never mask the caller's error.
      }
    }
  }
}

/**
 * Move the WAL *index* sidecars of an unopenable store into
 * `<storagePath>/recovery/<dbstem>-<timestamp>/` so the next open rebuilds them.
 * A non-empty `-wal` is deliberately left in place (see the module doc comment);
 * only an absent or 0-byte `-wal` is deleted.
 */
export async function quarantineWalSidecars(
  dbPath: string,
  connectFactory: ConnectFactory,
  opts: DatabaseOpts
): Promise<WalIndexRecoveryResult> {
  let quarantineDir: string | null = null;
  const moved: string[] = [];

  try {
    if (!existsSync(dbPath)) {
      return { status: "skipped", reason: "main database file is missing" };
    }
    if (!(await isCopiedDatabaseHealthy(dbPath, connectFactory, opts))) {
      return { status: "skipped", reason: "integrity_check failed on a copy of the main database" };
    }

    const walPath = `${dbPath}${WAL_FILE_SUFFIX}`;
    const walExists = existsSync(walPath);
    const walBytes = walExists ? statSync(walPath).size : 0;
    const indexSidecars = WAL_INDEX_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`).filter(
      (sidecar) => existsSync(sidecar)
    );
    const emptyingWal = walExists && walBytes === 0;

    if (indexSidecars.length === 0 && !emptyingWal) {
      // A non-empty WAL is never touched, so there is nothing left to recover.
      return { status: "skipped", reason: "no WAL index sidecars to quarantine" };
    }

    if (indexSidecars.length > 0) {
      quarantineDir = quarantineDirFor(dbPath);
      mkdirSync(quarantineDir, { recursive: true });
    }

    for (const sidecar of indexSidecars) {
      // quarantineDir is non-null whenever indexSidecars is non-empty.
      renameSync(sidecar, join(quarantineDir as string, basename(sidecar)));
      moved.push(basename(sidecar));
    }

    let removedEmptyWal = false;
    if (emptyingWal) {
      // Empty WAL: no frames, nothing to lose.
      rmSync(walPath, { force: true });
      removedEmptyWal = true;
    }

    return {
      status: "quarantined",
      quarantineDir,
      moved,
      removedEmptyWal,
      retainedWalBytes: walBytes,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: describeError(error),
      quarantineDir,
      moved,
    };
  }
}
