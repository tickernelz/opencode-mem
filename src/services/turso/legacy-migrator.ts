import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { tursoConnectionManager } from "./connection-manager.js";
import { tursoShardManager } from "./shard-manager.js";
import { tursoVectorSearch } from "./vector-search.js";
import { blobToFloat32Array } from "./vector-utils.js";
import type { MemoryRecord } from "./types.js";
import type { TursoDb } from "./turso-db.js";

const MIGRATION_MARKER = ".turso-migrated";
const MIGRATION_LOCK = ".turso-migrate.lock";
const SIDECAR_SUFFIX = ".turso-migrate.json";
const BACKUP_SUFFIX = ".legacy.bak";
const REEMBED_SWAP_SUFFIX = ".reembed-swap.json";

interface ShardMigrationSidecar {
  sourceCount: number;
  expectedCount: number;
  importedCount: number;
  skippedCount: number;
  status: "pending" | "complete";
}

interface MigrationMarker {
  completedAt: string;
  shards: Array<{ path: string; expectedCount: number; importedCount: number }>;
}

interface MigrationLock {
  pid: number;
  timestamp: string;
}

function sidecarPath(dbPath: string): string {
  return `${dbPath}${SIDECAR_SUFFIX}`;
}

function backupPath(dbPath: string): string {
  return `${dbPath}${BACKUP_SUFFIX}`;
}

function readSidecar(dbPath: string): ShardMigrationSidecar | null {
  const path = sidecarPath(dbPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ShardMigrationSidecar;
  } catch {
    return null;
  }
}

function writeSidecar(dbPath: string, sidecar: ShardMigrationSidecar): void {
  writeFileSync(sidecarPath(dbPath), JSON.stringify(sidecar, null, 2), "utf-8");
}

function readMarker(storagePath: string): MigrationMarker | null {
  const markerPath = join(storagePath, MIGRATION_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, "utf-8");
    const parsed = JSON.parse(raw) as MigrationMarker;
    if (parsed.completedAt && Array.isArray(parsed.shards)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeMarker(storagePath: string, shards: MigrationMarker["shards"]): void {
  const marker: MigrationMarker = {
    completedAt: new Date().toISOString(),
    shards,
  };
  writeFileSync(join(storagePath, MIGRATION_MARKER), JSON.stringify(marker, null, 2), "utf-8");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireMigrationLock(storagePath: string): boolean {
  const lockPath = join(storagePath, MIGRATION_LOCK);
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as MigrationLock;
      if (lock.pid && isProcessAlive(lock.pid)) {
        return false;
      }
      unlinkSync(lockPath);
    } catch {
      try {
        unlinkSync(lockPath);
      } catch {
        // stale or corrupt lock — try atomic create below
      }
    }
  }

  const lock: MigrationLock = { pid: process.pid, timestamp: new Date().toISOString() };
  try {
    writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function acquireMigrationLockWithRetry(storagePath: string, maxAttempts = 3): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (acquireMigrationLock(storagePath)) {
      return;
    }
    await sleep(200 + attempt * 150);
  }

  throw new Error("Turso legacy migration locked by another process");
}

function releaseMigrationLock(storagePath: string): void {
  const lockPath = join(storagePath, MIGRATION_LOCK);
  if (!existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as MigrationLock;
    if (lock.pid === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    unlinkSync(lockPath);
  }
}

async function countMemories(db: TursoDb): Promise<number> {
  const row = await db.get(`SELECT COUNT(*) as count FROM memories`);
  return Number(row?.count ?? 0);
}

async function hasMemoriesTable(db: TursoDb): Promise<boolean> {
  const row = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`);
  return Boolean(row);
}

async function isTursoVectorShardReady(db: TursoDb): Promise<boolean> {
  const indexRow = await db.get(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='memories_vec_idx'`
  );
  if (!indexRow) {
    return false;
  }

  const metaRow = await db.get(
    `SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`
  );
  if (!metaRow?.value) {
    return false;
  }

  const storedDimensions = Number(metaRow.value);
  if (!Number.isInteger(storedDimensions) || storedDimensions <= 0) {
    return false;
  }

  const count = await countMemories(db);
  if (count === 0) {
    return true;
  }

  try {
    const probe = await db.get(`SELECT vector_extract(vector) AS extracted FROM memories LIMIT 1`);
    if (probe?.extracted == null) return false;
    const extracted = JSON.parse(String(probe.extracted)) as unknown;
    return Array.isArray(extracted) && extracted.length === storedDimensions;
  } catch {
    return false;
  }
}

async function isShardMigrationComplete(dbPath: string): Promise<boolean> {
  const sidecar = readSidecar(dbPath);
  if (!sidecar || sidecar.status !== "complete") {
    return false;
  }

  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    const db = await tursoConnectionManager.getConnection(dbPath);
    if (!(await hasMemoriesTable(db))) {
      return sidecar.expectedCount === 0;
    }
    const count = await countMemories(db);
    if (count !== sidecar.expectedCount) {
      return false;
    }
    // Sidecar alone is not enough — require native vector index + readable vectors.
    return isTursoVectorShardReady(db);
  } catch {
    return false;
  }
}

async function restoreFromBackup(dbPath: string): Promise<void> {
  const backup = backupPath(dbPath);
  if (!existsSync(backup)) return;

  await tursoConnectionManager.closeConnection(dbPath);

  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }

  renameSync(backup, dbPath);

  const sidecarPathFile = sidecarPath(dbPath);
  if (existsSync(sidecarPathFile)) {
    unlinkSync(sidecarPathFile);
  }

  log("Legacy migration restored shard from backup", { dbPath, backup });
}

async function shouldRestoreFromBackup(dbPath: string): Promise<boolean> {
  const backup = backupPath(dbPath);
  if (!existsSync(backup)) return false;

  if (!existsSync(dbPath)) {
    return true;
  }

  try {
    const db = await tursoConnectionManager.getConnection(dbPath);
    const sidecar = readSidecar(dbPath);

    // A healthy Turso vector shard must not be overwritten by .legacy.bak,
    // except when a pending rewrite clearly did not finish importing all rows.
    if ((await hasMemoriesTable(db)) && (await isTursoVectorShardReady(db))) {
      if (sidecar?.status === "pending") {
        const count = await countMemories(db);
        if (count < sidecar.expectedCount) {
          return true;
        }
      }
      return false;
    }

    if (sidecar?.status === "complete") {
      return !(await isShardMigrationComplete(dbPath));
    }

    if (!(await hasMemoriesTable(db))) {
      return true;
    }

    const count = await countMemories(db);
    const expected = sidecar?.expectedCount ?? null;
    if (expected != null && count < expected) {
      return true;
    }
    if (sidecar?.status === "pending") {
      return true;
    }
  } catch {
    return true;
  }

  return false;
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord | null {
  const vector = blobToFloat32Array(row.vector);
  if (!vector) return null;

  const tagsVector = blobToFloat32Array(row.tags_vector) ?? undefined;
  return {
    id: String(row.id),
    content: String(row.content),
    vector,
    tagsVector,
    containerTag: String(row.container_tag),
    tags: row.tags ? String(row.tags) : undefined,
    type: row.type ? String(row.type) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata: row.metadata ? String(row.metadata) : undefined,
    displayName: row.display_name ? String(row.display_name) : undefined,
    userName: row.user_name ? String(row.user_name) : undefined,
    userEmail: row.user_email ? String(row.user_email) : undefined,
    projectPath: row.project_path ? String(row.project_path) : undefined,
    projectName: row.project_name ? String(row.project_name) : undefined,
    gitRepoUrl: row.git_repo_url ? String(row.git_repo_url) : undefined,
  };
}

async function migrateMemoryShard(dbPath: string): Promise<ShardMigrationSidecar | null> {
  if (await isShardMigrationComplete(dbPath)) {
    const sidecar = readSidecar(dbPath);
    return sidecar;
  }

  if (await shouldRestoreFromBackup(dbPath)) {
    await restoreFromBackup(dbPath);
  }

  if (await isShardMigrationComplete(dbPath)) {
    return readSidecar(dbPath);
  }

  const db = await tursoConnectionManager.getConnection(dbPath);
  const hasTable = await hasMemoriesTable(db);

  if (!hasTable) {
    await tursoShardManager.initShardDb(db);
    const sidecar: ShardMigrationSidecar = {
      sourceCount: 0,
      expectedCount: 0,
      importedCount: 0,
      skippedCount: 0,
      status: "complete",
    };
    writeSidecar(dbPath, sidecar);
    return sidecar;
  }

  if (await isTursoVectorShardReady(db)) {
    const count = await countMemories(db);
    const sidecar: ShardMigrationSidecar = {
      sourceCount: count,
      expectedCount: count,
      importedCount: count,
      skippedCount: 0,
      status: "complete",
    };
    writeSidecar(dbPath, sidecar);
    return sidecar;
  }

  const rows = await db.all(`SELECT * FROM memories`);
  const records: MemoryRecord[] = [];
  const pinnedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const row of rows) {
    const record = rowToRecord(row);
    if (!record) {
      skippedIds.push(String(row.id));
      log("Legacy migration skipped memory without vector", { memoryId: row.id, dbPath });
      continue;
    }
    records.push(record);
    if (Number(row.is_pinned) === 1) {
      pinnedIds.push(record.id);
    }
  }

  const sourceCount = rows.length;
  const skippedCount = skippedIds.length;

  if (skippedCount > 0) {
    throw new Error(
      `Legacy migration aborted for ${dbPath}: ${skippedCount} of ${sourceCount} memories have unreadable vectors (${skippedIds.join(", ")})`
    );
  }

  const sourceDimensions = records[0]?.vector.length ?? CONFIG.embeddingDimensions;
  if (!Number.isInteger(sourceDimensions) || sourceDimensions <= 0 || sourceDimensions > 65536) {
    throw new Error(
      `Legacy migration aborted for ${dbPath}: invalid source vector dimensions ${sourceDimensions}`
    );
  }
  const dimensionMismatches = records.filter(
    (record) =>
      record.vector.length !== sourceDimensions ||
      (record.tagsVector != null && record.tagsVector.length !== sourceDimensions)
  );
  if (dimensionMismatches.length > 0) {
    const sample = dimensionMismatches
      .slice(0, 5)
      .map(
        (record) =>
          `${record.id}(vector=${record.vector.length}` +
          (record.tagsVector ? `,tags=${record.tagsVector.length}` : "") +
          ")"
      )
      .join(", ");
    throw new Error(
      `Legacy migration aborted for ${dbPath}: ${dimensionMismatches.length} memories have inconsistent vector dimensions; expected ${sourceDimensions} (${sample})`
    );
  }

  const expectedCount = records.length;
  writeSidecar(dbPath, {
    sourceCount,
    expectedCount,
    importedCount: 0,
    skippedCount,
    status: "pending",
  });

  const backup = backupPath(dbPath);
  await tursoConnectionManager.closeConnection(dbPath);
  if (existsSync(dbPath)) {
    renameSync(dbPath, backup);
  }

  const freshDb = await tursoConnectionManager.getConnection(dbPath);
  const sourceModel =
    sourceDimensions === CONFIG.embeddingDimensions ? CONFIG.embeddingModel : "legacy-unknown";
  await tursoShardManager.initShardDb(freshDb, sourceDimensions, sourceModel);

  const BATCH_SIZE = 50;
  await freshDb.transaction("write", async (tx) => {
    for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
      const batch = records.slice(offset, offset + BATCH_SIZE);
      for (const record of batch) {
        await tursoVectorSearch.insertVectorInTransaction(tx, record);
      }
    }
    for (const memoryId of pinnedIds) {
      await tx.execute({
        sql: `UPDATE memories SET is_pinned = 1 WHERE id = ?`,
        args: [memoryId],
      });
    }
  });

  const importedCount = await countMemories(freshDb);
  if (importedCount !== expectedCount) {
    throw new Error(
      `Legacy migration count mismatch for ${dbPath}: expected ${expectedCount}, got ${importedCount}`
    );
  }

  const completedSidecar: ShardMigrationSidecar = {
    sourceCount,
    expectedCount,
    importedCount,
    skippedCount,
    status: "complete",
  };
  writeSidecar(dbPath, completedSidecar);

  log("Legacy memory shard migrated to Turso vectors", {
    dbPath,
    memories: expectedCount,
    backupPath: backup,
  });

  return completedSidecar;
}

async function migrateDirectory(
  dirName: "users" | "projects"
): Promise<Array<{ path: string; sidecar: ShardMigrationSidecar }>> {
  const dir = join(CONFIG.storagePath, dirName);
  const results: Array<{ path: string; sidecar: ShardMigrationSidecar }> = [];
  if (!existsSync(dir)) return results;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".db") || file.includes(BACKUP_SUFFIX)) continue;
    const dbPath = join(dir, file);
    const sidecar = await migrateMemoryShard(dbPath);
    if (sidecar) {
      results.push({ path: dbPath, sidecar });
    }
  }

  return results;
}

function listAllShardDbPaths(): string[] {
  const paths: string[] = [];
  for (const dirName of ["users", "projects"] as const) {
    const dir = join(CONFIG.storagePath, dirName);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".db") || file.includes(BACKUP_SUFFIX)) continue;
      paths.push(join(dir, file));
    }
  }
  return paths;
}

async function allShardsComplete(): Promise<boolean> {
  const paths = listAllShardDbPaths();
  if (paths.length === 0) return true;
  for (const dbPath of paths) {
    if (!(await isShardMigrationComplete(dbPath))) {
      return false;
    }
  }
  return true;
}

function recoverInterruptedReembedSwaps(): void {
  for (const dirName of ["users", "projects"] as const) {
    const dir = join(CONFIG.storagePath, dirName);
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(REEMBED_SWAP_SUFFIX)) continue;
      const statePath = join(dir, file);
      const expectedDbPath = statePath.slice(0, -REEMBED_SWAP_SUFFIX.length);
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
          dbPath?: string;
          stagedPath?: string;
          backupPath?: string;
        };
        const stagedPath = state.stagedPath;
        const backupPath = state.backupPath;
        const valid =
          state.dbPath === expectedDbPath &&
          typeof stagedPath === "string" &&
          stagedPath.startsWith(`${expectedDbPath}.reembed-`) &&
          stagedPath.endsWith(".tmp") &&
          typeof backupPath === "string" &&
          backupPath.startsWith(`${expectedDbPath}.pre-reembed-`) &&
          backupPath.endsWith(".bak");
        if (!valid) {
          throw new Error("invalid re-embed swap state paths");
        }

        if (existsSync(expectedDbPath)) {
          if (existsSync(stagedPath)) unlinkSync(stagedPath);
        } else if (existsSync(stagedPath)) {
          renameSync(stagedPath, expectedDbPath);
        } else if (existsSync(backupPath)) {
          renameSync(backupPath, expectedDbPath);
        } else {
          throw new Error("neither staged replacement nor source backup exists");
        }
        unlinkSync(statePath);
        log("Recovered interrupted re-embed shard swap", { dbPath: expectedDbPath });
      } catch (error) {
        throw new Error(`Failed to recover re-embed swap ${statePath}: ${String(error)}`);
      }
    }
  }
}

async function reconcileShardRegistry(): Promise<void> {
  const parsedShards: Array<{
    path: string;
    scope: "user" | "project";
    scopeHash: string;
    shardIndex: number;
    vectorCount: number;
  }> = [];

  for (const path of listAllShardDbPaths()) {
    const match = /^(user|project)_([a-f0-9]{16})_shard_(\d+)\.db$/.exec(basename(path));
    if (!match) {
      log("Legacy migration left unrecognized shard filename unregistered", { path });
      continue;
    }

    const db = await tursoConnectionManager.getConnection(path);
    parsedShards.push({
      path,
      scope: match[1] as "user" | "project",
      scopeHash: match[2]!,
      shardIndex: Number(match[3]),
      vectorCount: await countMemories(db),
    });
  }

  const highestIndexByScope = new Map<string, number>();
  for (const shard of parsedShards) {
    const key = `${shard.scope}:${shard.scopeHash}`;
    highestIndexByScope.set(key, Math.max(highestIndexByScope.get(key) ?? -1, shard.shardIndex));
  }

  for (const shard of parsedShards) {
    const key = `${shard.scope}:${shard.scopeHash}`;
    await tursoShardManager.registerExistingShard(
      shard.scope,
      shard.scopeHash,
      shard.shardIndex,
      shard.path,
      shard.vectorCount,
      shard.shardIndex === highestIndexByScope.get(key)
    );
  }
}

export async function runLegacyTursoMigration(): Promise<void> {
  if (!existsSync(CONFIG.storagePath)) {
    mkdirSync(CONFIG.storagePath, { recursive: true });
  }

  recoverInterruptedReembedSwaps();

  const marker = readMarker(CONFIG.storagePath);
  if (marker && (await allShardsComplete())) {
    await reconcileShardRegistry();
    return;
  }

  await acquireMigrationLockWithRetry(CONFIG.storagePath);

  try {
    const dbFiles = ["metadata.db", "user-prompts.db", "user-profiles.db", "ai-sessions.db"];
    for (const file of dbFiles) {
      const path = join(CONFIG.storagePath, file);
      if (!existsSync(path)) continue;
      await tursoConnectionManager.getConnection(path);
    }

    const migratedShards: MigrationMarker["shards"] = [];

    for (const dirName of ["users", "projects"] as const) {
      const dirResults = await migrateDirectory(dirName);
      for (const { path, sidecar } of dirResults) {
        migratedShards.push({
          path,
          expectedCount: sidecar.expectedCount,
          importedCount: sidecar.importedCount,
        });
      }
    }

    if (!(await allShardsComplete())) {
      throw new Error("Turso legacy migration incomplete: not all shards verified");
    }

    await reconcileShardRegistry();
    writeMarker(CONFIG.storagePath, migratedShards);
    log("Turso legacy migration complete", { storagePath: CONFIG.storagePath });
  } finally {
    releaseMigrationLock(CONFIG.storagePath);
  }
}
