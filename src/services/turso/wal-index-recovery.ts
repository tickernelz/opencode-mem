import type { Database } from "@tursodatabase/database";
import type { DatabaseOpts } from "@tursodatabase/database-common";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import type { ConnectFactory } from "./connection-manager.js";

/**
 * Turso keeps its multiprocess WAL index in `<db>-tshm`; stock sqlite uses
 * `<db>-shm`. A `-tshm` (or `-shm`) that outlives the WAL it indexes makes the
 * next open fail with one of these two errors (see issue #435):
 *   - "I/O error: short read on WAL frame at offset N: expected 4096 bytes, got 0"
 *   - "Corrupt database: Invalid page type: 0"
 * The main `.db` itself stays intact, so the store is recoverable by discarding
 * the sidecars.
 */
const WAL_INDEX_CORRUPTION_PATTERNS = [
  /short read on WAL frame at offset \d+/i,
  /invalid page type:\s*0\b/i,
];

export const WAL_SIDECAR_SUFFIXES = ["-shm", "-tshm", "-wal"] as const;

/** True for the two "stale WAL index" open failures that self-heal can repair. */
export function isWalIndexCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return WAL_INDEX_CORRUPTION_PATTERNS.some((pattern) => pattern.test(message));
}

export type WalIndexRecoveryResult =
  | { status: "quarantined"; quarantineDir: string; moved: string[] }
  | { status: "skipped"; reason: string };

function quarantineDirFor(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = basename(dbPath, extname(dbPath));
  return join(CONFIG.storagePath, "recovery", `${stem}-${stamp}`);
}

/**
 * Verify a copy of the main database file. The live file is never opened with a
 * different engine — that is what produces the "Invalid page type: 0" class.
 */
async function isCopiedDatabaseHealthy(
  dbPath: string,
  connectFactory: ConnectFactory,
  opts: DatabaseOpts
): Promise<boolean> {
  const tempDir = mkdtempSync(join(tmpdir(), "opencode-mem-wal-check-"));
  try {
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
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Move the WAL sidecars of an unopenable store into
 * `<storagePath>/recovery/<dbstem>-<timestamp>/` so the next open starts clean.
 * Sidecars are moved, never deleted, and only after a copy of the main `.db`
 * passes `PRAGMA integrity_check`.
 */
export async function quarantineWalSidecars(
  dbPath: string,
  connectFactory: ConnectFactory,
  opts: DatabaseOpts
): Promise<WalIndexRecoveryResult> {
  if (!existsSync(dbPath)) {
    return { status: "skipped", reason: "main database file is missing" };
  }
  if (!(await isCopiedDatabaseHealthy(dbPath, connectFactory, opts))) {
    return { status: "skipped", reason: "integrity_check failed on a copy of the main database" };
  }

  const quarantineDir = quarantineDirFor(dbPath);
  mkdirSync(quarantineDir, { recursive: true });
  const moved: string[] = [];
  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    renameSync(sidecar, join(quarantineDir, basename(sidecar)));
    moved.push(basename(sidecar));
  }
  return { status: "quarantined", quarantineDir, moved };
}
