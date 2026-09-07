import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { CONFIG } from "../config.js";
import { extractScopeFromContainerTag } from "./memory-scope.js";
import { getProjectTagInfo } from "./tags.js";
import { ensureTursoReady } from "./turso/ready.js";
import { acquireTursoOperationLock } from "./turso/operation-lock.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { withSqliteFileLockRetry } from "./turso/sqlite-handle-release.js";
import { log } from "./logger.js";
import {
  shardInventoryService,
  type ResolveMigrationSourceOptions,
  type ResolvedMigrationSource,
} from "./shard-inventory-service.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

export interface PathMigrationOptions extends ResolveMigrationSourceOptions {
  currentDirectory: string;
  dryRun?: boolean;
  allowLinkedSource?: boolean;
}

export interface PathMigrationAction {
  type:
    "rename" | "archive-empty-target" | "update-memories" | "update-prompts" | "reassign-metadata";
  detail: string;
}

export interface PathMigrationResult {
  success: boolean;
  dryRun: boolean;
  migratedShards?: number;
  migratedMemories?: number;
  oldPath?: string | null;
  newPath?: string;
  oldHash?: string;
  newHash?: string;
  matchedBy?: ResolvedMigrationSource["matchedBy"];
  actions?: PathMigrationAction[];
  error?: string;
  candidates?: unknown[];
}

interface ShardMove {
  shardId: number;
  shardIndex: number;
  oldPath: string;
  newPath: string;
  stagedPath: string;
  backupPath: string;
  isActive: boolean;
  vectorCount: number;
  oldContainerTag: string;
}

interface ArchivedTarget {
  shardId: number;
  shardIndex: number;
  originalPath: string;
  archivePath: string | null;
  isActive: boolean;
  vectorCount: number;
}

interface PathMigrateSwapState {
  operation: "path-migrate";
  oldHash: string;
  newHash: string;
  moves: ShardMove[];
  archivedTargets: ArchivedTarget[];
}

function swapStatePath(): string {
  return join(CONFIG.storagePath, ".path-migrate-swap.json");
}

function writeSwapState(path: string, state: PathMigrateSwapState): void {
  writeFileSync(path, JSON.stringify(state), "utf-8");
}

function assertRecoveryPathInsideStorage(path: string): void {
  const rel = relative(resolve(CONFIG.storagePath), resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.includes("\0")) {
    throw new Error(`Path-migrate recovery path escapes storage: ${path}`);
  }
}

async function countLiveMemories(dbPath: string): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  const db = await tursoConnectionManager.getConnection(dbPath);
  return tursoVectorSearch.countAllVectors(db);
}

async function removeFile(path: string): Promise<void> {
  await tursoConnectionManager.closeConnection(path);
  if (existsSync(path)) {
    await withSqliteFileLockRetry(() => unlinkSync(path));
  }
}

export class ShardPathMigrationService {
  async migrate(options: PathMigrationOptions): Promise<PathMigrationResult> {
    await ensureTursoReady();

    const target = getProjectTagInfo(options.currentDirectory);
    const newHash = extractScopeFromContainerTag(target.tag).hash;
    const resolveResult = await shardInventoryService.resolveMigrationSource(
      options.currentDirectory,
      { fromPath: options.fromPath, fromHash: options.fromHash }
    );

    if (!resolveResult.success || !resolveResult.source) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        error: resolveResult.error,
        candidates: resolveResult.candidates,
      };
    }

    const source = resolveResult.source;
    const oldHash = source.scopeHash;
    const resultBase = {
      dryRun: Boolean(options.dryRun),
      oldHash,
      newHash,
      oldPath: source.group.projectPath,
      newPath: target.projectPath,
      matchedBy: source.matchedBy,
    };

    if (oldHash === newHash) {
      return {
        success: true,
        ...resultBase,
        migratedShards: 0,
        migratedMemories: 0,
        actions: [],
      };
    }

    if (source.group.pathExists && !options.allowLinkedSource) {
      return {
        success: false,
        ...resultBase,
        error:
          `Migration refused: source project path still exists (${source.group.projectPath}). ` +
          "Set allowLinkedSource: true only after confirming that this active project should be reassociated.",
      };
    }

    // Inventory may discover a valid shard added after startup reconciliation.
    // Register it so list-shards and migrate operate on the same set.
    for (const descriptor of source.group.shards) {
      if (descriptor.shardId === null && descriptor.fileExists) {
        await tursoShardManager.registerExistingShard(
          "project",
          oldHash,
          descriptor.shardIndex,
          descriptor.dbPath,
          descriptor.memoryCount,
          descriptor.isActive
        );
      }
    }

    const sourceShards = await tursoShardManager.getAllShards("project", oldHash);
    if (sourceShards.length === 0) {
      return {
        success: false,
        ...resultBase,
        error: `No usable shards found for source hash ${oldHash}`,
      };
    }

    // Strict conflict policy: any non-empty target aborts unchanged.
    const targetShards = await tursoShardManager.getAllShards("project", newHash);
    for (const shard of targetShards) {
      const liveCount = await countLiveMemories(shard.dbPath);
      if (liveCount > 0 || shard.vectorCount > 0) {
        return {
          success: false,
          ...resultBase,
          error:
            `Migration aborted: target project already has ${Math.max(liveCount, shard.vectorCount)} memories ` +
            `(shard ${basename(shard.dbPath)}). Delete or forget those memories first, or use export/import.`,
        };
      }
    }

    const oldContainerTag =
      source.group.containerTag ?? `${CONFIG.containerTagPrefix}_project_${oldHash}`;
    const nonce = `${process.pid}-${Date.now()}`;
    const moves: ShardMove[] = sourceShards.map((shard) => {
      const newPath = tursoShardManager.getShardPath("project", newHash, shard.shardIndex);
      const inventoryShard = source.group.shards.find(
        (candidate) => candidate.shardIndex === shard.shardIndex
      );
      return {
        shardId: shard.id,
        shardIndex: shard.shardIndex,
        oldPath: shard.dbPath,
        newPath,
        stagedPath: `${newPath}.path-migrate-${nonce}.tmp`,
        backupPath: `${shard.dbPath}.pre-path-migrate-${nonce}.bak`,
        isActive: shard.isActive,
        vectorCount: inventoryShard?.memoryCount ?? shard.vectorCount,
        oldContainerTag,
      };
    });

    for (const move of moves) {
      if (existsSync(move.newPath) && !targetShards.some((s) => s.dbPath === move.newPath)) {
        if ((await countLiveMemories(move.newPath)) > 0) {
          return {
            success: false,
            ...resultBase,
            error: `Migration aborted: target shard file already contains memories (${basename(move.newPath)}).`,
          };
        }
      }
    }

    const actions: PathMigrationAction[] = moves.map((move) => ({
      type: "rename",
      detail: `${basename(move.oldPath)} -> ${basename(move.newPath)}`,
    }));
    for (const shard of targetShards) {
      actions.push({ type: "archive-empty-target", detail: basename(shard.dbPath) });
    }
    const migratedMemories = (
      await Promise.all(moves.map((move) => countLiveMemories(move.oldPath)))
    ).reduce((sum, count) => sum + count, 0);
    actions.push({
      type: "update-memories",
      detail: `Remap container_tag and project metadata for ${migratedMemories} memories`,
    });
    if (source.group.projectPath && target.projectPath) {
      actions.push({
        type: "update-prompts",
        detail: `${source.group.projectPath} -> ${target.projectPath}`,
      });
    }

    if (options.dryRun) {
      return {
        success: true,
        ...resultBase,
        migratedShards: moves.length,
        migratedMemories,
        actions,
      };
    }

    const releaseLock = acquireTursoOperationLock("path-migrate");
    const statePath = swapStatePath();
    const archivedTargets: ArchivedTarget[] = targetShards.map((shard) => ({
      shardId: shard.id,
      shardIndex: shard.shardIndex,
      originalPath: shard.dbPath,
      archivePath: `${shard.dbPath}.pre-path-migrate-${nonce}.bak`,
      isActive: shard.isActive,
      vectorCount: shard.vectorCount,
    }));
    const state: PathMigrateSwapState = {
      operation: "path-migrate",
      oldHash,
      newHash,
      moves,
      archivedTargets,
    };

    try {
      // Stage complete, updated copies while originals remain untouched.
      for (const move of moves) {
        await tursoConnectionManager.closeConnection(move.oldPath);
        if (!existsSync(move.oldPath)) {
          throw new Error(`Source shard file missing: ${move.oldPath}`);
        }
        await removeFile(move.stagedPath);
        copyFileSync(move.oldPath, move.stagedPath);

        const stagedDb = await tursoConnectionManager.getConnection(move.stagedPath);
        await tursoVectorSearch.updateProjectAssociation(stagedDb, move.oldContainerTag, {
          containerTag: target.tag,
          projectPath: target.projectPath,
          projectName: target.projectName,
          displayName: target.displayName,
          gitRepoUrl: target.gitRepoUrl ?? null,
        });
        await stagedDb.run(
          `UPDATE memories SET
             container_tag = ?, project_path = ?, project_name = ?,
             display_name = ?, git_repo_url = ?
           WHERE container_tag != ?`,
          [
            target.tag,
            target.projectPath ?? null,
            target.projectName ?? null,
            target.displayName ?? null,
            target.gitRepoUrl ?? null,
            target.tag,
          ]
        );
        const stagedCount = await tursoVectorSearch.countAllVectors(stagedDb);
        if (stagedCount !== move.vectorCount) {
          throw new Error(
            `Staged shard count mismatch for ${basename(move.oldPath)}: expected ${move.vectorCount}, got ${stagedCount}`
          );
        }
        await tursoConnectionManager.closeConnection(move.stagedPath);
      }

      writeSwapState(statePath, state);

      // Empty targets remain recoverable until the complete swap succeeds.
      for (let index = 0; index < targetShards.length; index++) {
        await tursoShardManager.archiveShard(
          targetShards[index]!.id,
          "pre-path-migrate",
          archivedTargets[index]!.archivePath!
        );
      }

      for (const move of moves) {
        await tursoConnectionManager.closeConnection(move.oldPath);
        await withSqliteFileLockRetry(() => renameSync(move.oldPath, move.backupPath));
        try {
          await withSqliteFileLockRetry(() => renameSync(move.stagedPath, move.newPath));
        } catch (error) {
          await withSqliteFileLockRetry(() => renameSync(move.backupPath, move.oldPath));
          throw error;
        }

        await tursoShardManager.reassignShardScope(
          move.shardId,
          newHash,
          move.newPath,
          move.vectorCount,
          move.isActive
        );
        actions.push({
          type: "reassign-metadata",
          detail: `shard ${move.shardId} -> ${newHash}#${move.shardIndex}`,
        });
      }

      unlinkSync(statePath);

      // Prompt metadata is secondary and must not invalidate a completed,
      // recoverable memory migration.
      if (source.group.projectPath && target.projectPath) {
        try {
          await userPromptManager.updateProjectPath(source.group.projectPath, target.projectPath);
        } catch (error) {
          log("Path migration prompt metadata update failed", { error: String(error) });
        }
      }

      log("Path migration completed", {
        oldHash,
        newHash,
        migratedShards: moves.length,
        migratedMemories,
      });
      return {
        success: true,
        ...resultBase,
        dryRun: false,
        migratedShards: moves.length,
        migratedMemories,
        actions,
      };
    } catch (error) {
      await this.rollbackSwap(state, statePath);
      return {
        success: false,
        ...resultBase,
        dryRun: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      releaseLock();
    }
  }

  private async rollbackSwap(state: PathMigrateSwapState, statePath: string): Promise<void> {
    let rollbackFailed = false;

    for (const move of [...state.moves].reverse()) {
      try {
        await tursoConnectionManager.closeConnection(move.newPath);
        await tursoConnectionManager.closeConnection(move.stagedPath);
        if (existsSync(move.backupPath)) {
          await removeFile(move.newPath);
          await removeFile(move.oldPath);
          await withSqliteFileLockRetry(() => renameSync(move.backupPath, move.oldPath));
        }
        await removeFile(move.stagedPath);
        if (existsSync(move.oldPath)) {
          await tursoShardManager.reassignShardScope(
            move.shardId,
            state.oldHash,
            move.oldPath,
            move.vectorCount,
            move.isActive
          );
        }
      } catch (error) {
        rollbackFailed = true;
        log("Path migration source rollback failed", { move, error: String(error) });
      }
    }

    for (const archived of state.archivedTargets) {
      try {
        if (archived.archivePath && existsSync(archived.archivePath)) {
          await removeFile(archived.originalPath);
          await withSqliteFileLockRetry(() =>
            renameSync(archived.archivePath!, archived.originalPath)
          );
          await tursoShardManager.registerExistingShard(
            "project",
            state.newHash,
            archived.shardIndex,
            archived.originalPath,
            archived.vectorCount,
            archived.isActive
          );
        }
      } catch (error) {
        rollbackFailed = true;
        log("Path migration target rollback failed", { archived, error: String(error) });
      }
    }

    // Startup reconciliation may have registered a newly renamed shard before
    // recovery ran. Remove only registry rows whose files no longer exist.
    try {
      const staleTargets = await tursoShardManager.getAllShards("project", state.newHash);
      for (const shard of staleTargets) {
        if (!existsSync(shard.dbPath)) {
          await tursoShardManager.deleteShard(shard.id);
        }
      }
    } catch (error) {
      rollbackFailed = true;
      log("Path migration stale target cleanup failed", { error: String(error) });
    }

    if (!rollbackFailed && existsSync(statePath)) {
      unlinkSync(statePath);
    } else if (rollbackFailed && !existsSync(statePath)) {
      writeSwapState(statePath, state);
    }
  }

  /** Roll back an interrupted staged swap before normal storage access resumes. */
  async recoverInterruptedSwap(): Promise<void> {
    const statePath = swapStatePath();
    if (!existsSync(statePath)) return;

    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as PathMigrateSwapState;
      if (
        state.operation !== "path-migrate" ||
        !Array.isArray(state.moves) ||
        !Array.isArray(state.archivedTargets)
      ) {
        throw new Error("invalid path-migrate swap state");
      }
      for (const move of state.moves) {
        for (const path of [move.oldPath, move.newPath, move.stagedPath, move.backupPath]) {
          assertRecoveryPathInsideStorage(path);
        }
      }
      for (const archived of state.archivedTargets) {
        assertRecoveryPathInsideStorage(archived.originalPath);
        if (archived.archivePath) assertRecoveryPathInsideStorage(archived.archivePath);
      }

      await this.rollbackSwap(state, statePath);
      if (existsSync(statePath)) {
        throw new Error("rollback could not restore every shard");
      }
      log("Recovered interrupted path migration", {
        oldHash: state.oldHash,
        newHash: state.newHash,
      });
    } catch (error) {
      throw new Error(`Failed to recover path-migrate swap ${statePath}: ${String(error)}`);
    }
  }
}

export const shardPathMigrationService = new ShardPathMigrationService();
