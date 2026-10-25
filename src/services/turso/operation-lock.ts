import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";

const OPERATION_LOCK = ".turso-operation.lock";
const LEGACY_MIGRATION_LOCK = ".turso-migrate.lock";

// Thirty minutes of progress silence is far longer than a local 50-row insert
// batch, shard swap, or individual embedding request. Long migrations heartbeat
// at those boundaries, so total migration duration is not limited by this lease.
export const TURSO_LOCK_STALE_MS = 30 * 60 * 1000;

interface LockState {
  pid: number;
  timestamp?: string;
  operation?: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockAgeMs(path: string, state: LockState | null): number | null {
  let timestamp = typeof state?.timestamp === "string" ? Date.parse(state.timestamp) : NaN;
  if (!Number.isFinite(timestamp)) {
    try {
      timestamp = statSync(path).mtimeMs;
    } catch {
      // Without a usable timestamp or mtime, fail closed for a live PID.
    }
  }
  return Number.isFinite(timestamp) ? Date.now() - timestamp : null;
}

/** Shared lease check for both write gating and atomic migration acquisition. */
export function readLiveTursoLock(path: string): LockState | null {
  if (!existsSync(path)) return null;
  let state: LockState | null = null;
  let reason = "corrupt lock";
  try {
    state = JSON.parse(readFileSync(path, "utf-8")) as LockState | null;
    if (state && Number.isInteger(state.pid) && state.pid > 0) {
      const age = lockAgeMs(path, state);
      if (isProcessAlive(state.pid)) {
        if (age === null || age <= TURSO_LOCK_STALE_MS) return state;
        reason = "progress heartbeat expired";
      } else {
        reason = "dead PID";
      }
    }
  } catch {
    // Corrupt locks are stale and removed below.
  }
  const ageMs = lockAgeMs(path, state);
  let removed = false;
  try {
    unlinkSync(path);
    removed = true;
  } catch {
    // Already removed (race) or held open (Windows) — either way the lock is
    // gone or unowned; do not let cleanup failure block writes.
  }
  const details = {
    path,
    pid: state?.pid ?? null,
    ageMs,
    operation: state?.operation,
    reason,
    removed,
  };
  try {
    log("WARNING: Invalidating stale Turso migration lock", details);
  } catch {
    // Audit even when the log destination is unavailable; logging must not
    // turn an unowned lock into a permanent write outage.
    console.warn("WARNING: Invalidating stale Turso migration lock", details);
  }
  return null;
}

/** Refresh progress only while this process still owns the lease. */
export function heartbeatTursoLock(path: string): void {
  let fd: number | undefined;
  try {
    // Open without creating, and update the same file we checked. If another
    // process replaces the path, we must not overwrite its new lease.
    fd = openSync(path, "r+");
    const previous = readFileSync(fd, "utf-8");
    const state = JSON.parse(previous) as LockState | null;
    if (state?.pid !== process.pid) throw new Error("lock owner changed");
    const updated = JSON.stringify({ ...state, timestamp: new Date().toISOString() });
    // Keep any shortened tail as JSON whitespace rather than leaving a corrupt
    // window between a rewrite and truncate (older locks may be pretty-printed).
    const padding = Math.max(0, Buffer.byteLength(previous) - Buffer.byteLength(updated));
    const contents = Buffer.from(updated + " ".repeat(padding));
    writeSync(fd, contents, 0, contents.length, 0);
    const opened = fstatSync(fd);
    const current = statSync(path);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("lock file replaced");
    }
  } catch (error) {
    throw new Error(`Turso migration lock ownership lost at ${path}; aborting migration`, {
      cause: error,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function assertNoTursoMigrationInProgress(): void {
  for (const file of [OPERATION_LOCK, LEGACY_MIGRATION_LOCK]) {
    const path = join(CONFIG.storagePath, file);
    const state = readLiveTursoLock(path);
    if (state) {
      throw new Error(
        `Database migration is in progress${state.operation ? ` (${state.operation})` : ""} ` +
          `in process ${state.pid}; writes are temporarily blocked`
      );
    }
  }
}

export function acquireTursoOperationLock(
  operation: string
): (() => void) & { heartbeat: () => void } {
  assertNoTursoMigrationInProgress();
  const path = join(CONFIG.storagePath, OPERATION_LOCK);
  const state: LockState = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    operation,
  };
  writeFileSync(path, JSON.stringify(state), { flag: "wx" });

  const release = () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf-8")) as LockState | null;
      if (current?.pid === process.pid) unlinkSync(path);
    } catch {
      // Missing, replaced, corrupt, or held open: cleanup must not block writes.
    }
  };
  return Object.assign(release, { heartbeat: () => heartbeatTursoLock(path) });
}
