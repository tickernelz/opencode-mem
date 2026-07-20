import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../../config.js";

const OPERATION_LOCK = ".turso-operation.lock";
const LEGACY_MIGRATION_LOCK = ".turso-migrate.lock";

interface LockState {
  pid: number;
  timestamp: string;
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

function readLiveLock(path: string): LockState | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as LockState;
    if (Number.isInteger(state.pid) && state.pid > 0 && isProcessAlive(state.pid)) {
      return state;
    }
  } catch {
    // Corrupt locks are stale and removed below.
  }
  unlinkSync(path);
  return null;
}

export function assertNoTursoMigrationInProgress(): void {
  for (const file of [OPERATION_LOCK, LEGACY_MIGRATION_LOCK]) {
    const path = join(CONFIG.storagePath, file);
    const state = readLiveLock(path);
    if (state) {
      throw new Error(
        `Database migration is in progress${state.operation ? ` (${state.operation})` : ""} ` +
          `in process ${state.pid}; writes are temporarily blocked`
      );
    }
  }
}

export function acquireTursoOperationLock(operation: string): () => void {
  assertNoTursoMigrationInProgress();
  const path = join(CONFIG.storagePath, OPERATION_LOCK);
  const state: LockState = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    operation,
  };
  writeFileSync(path, JSON.stringify(state), { flag: "wx" });

  return () => {
    const current = readLiveLock(path);
    if (current?.pid === process.pid && existsSync(path)) {
      unlinkSync(path);
    }
  };
}
