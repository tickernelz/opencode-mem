import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { ensureTursoReady } from "./turso/ready.js";
import { embeddingService } from "./embedding.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { formatTagsForEmbedding } from "./turso/vector-utils.js";
import type { MemoryRecord, ShardInfo } from "./turso/types.js";
import { acquireTursoOperationLock } from "./turso/operation-lock.js";

export interface DimensionMismatch {
  needsMigration: boolean;
  configDimensions: number;
  configModel: string;
  shardMismatches: Array<{
    shardId: number;
    dbPath: string;
    storedDimensions: number;
    storedModel: string;
    vectorCount: number;
  }>;
}

export interface MigrationProgress {
  phase: "preparing" | "re-embedding" | "cleanup" | "complete";
  processed: number;
  total: number;
  currentShard?: string;
}

export interface MigrationResult {
  success: boolean;
  strategy: "fresh-start" | "re-embed";
  deletedShards: number;
  reEmbeddedMemories: number;
  duration: number;
  error?: string;
}

export class MigrationService {
  private isRunning: boolean = false;
  private progressCallback?: (progress: MigrationProgress) => void;

  async detectDimensionMismatch(): Promise<DimensionMismatch> {
    await ensureTursoReady();
    const userShards = await tursoShardManager.getAllShards("user", "");
    const projectShards = await tursoShardManager.getAllShards("project", "");
    const allShards = [...userShards, ...projectShards];

    const mismatches: DimensionMismatch["shardMismatches"] = [];

    for (const shard of allShards) {
      try {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const metadataResult = await db.all(
          `
          SELECT key, value FROM shard_metadata
          WHERE key IN ('embedding_dimensions', 'embedding_model')
        `
        );

        const metadata = Object.fromEntries(metadataResult.map((row) => [row.key, row.value]));
        const storedDimensions = parseInt(String(metadata.embedding_dimensions || "0"));
        const storedModel = String(metadata.embedding_model || "unknown");

        if (storedDimensions !== CONFIG.embeddingDimensions) {
          const vectorCount = await tursoVectorSearch.countAllVectors(db);
          mismatches.push({
            shardId: shard.id,
            dbPath: shard.dbPath,
            storedDimensions,
            storedModel,
            vectorCount,
          });
        }
      } catch (error) {
        log("Migration: error checking shard", {
          shardId: shard.id,
          error: String(error),
        });
      }
    }

    return {
      needsMigration: mismatches.length > 0,
      configDimensions: CONFIG.embeddingDimensions,
      configModel: CONFIG.embeddingModel,
      shardMismatches: mismatches,
    };
  }

  async migrateToNewModel(
    strategy: "fresh-start" | "re-embed",
    progressCallback?: (progress: MigrationProgress) => void
  ): Promise<MigrationResult> {
    if (this.isRunning) {
      throw new Error("Migration already running");
    }

    this.isRunning = true;
    let releaseOperationLock: (() => void) | undefined;
    this.progressCallback = progressCallback;
    const startTime = Date.now();

    try {
      releaseOperationLock = acquireTursoOperationLock(`dimension-${strategy}`);
      const mismatch = await this.detectDimensionMismatch();

      if (!mismatch.needsMigration) {
        return {
          success: true,
          strategy,
          deletedShards: 0,
          reEmbeddedMemories: 0,
          duration: Date.now() - startTime,
        };
      }

      if (strategy === "fresh-start") {
        return await this.freshStartMigration(mismatch, startTime);
      }

      return await this.reEmbedMigration(mismatch, startTime);
    } catch (error) {
      log("Migration: failed", { error: String(error) });
      return {
        success: false,
        strategy,
        deletedShards: 0,
        reEmbeddedMemories: 0,
        duration: Date.now() - startTime,
        error: String(error),
      };
    } finally {
      releaseOperationLock?.();
      this.isRunning = false;
      this.progressCallback = undefined;
    }
  }

  private async freshStartMigration(
    mismatch: DimensionMismatch,
    startTime: number
  ): Promise<MigrationResult> {
    this.reportProgress({
      phase: "preparing",
      processed: 0,
      total: mismatch.shardMismatches.length,
    });

    let deletedShards = 0;

    for (const [index, shardInfo] of mismatch.shardMismatches.entries()) {
      this.reportProgress({
        phase: "cleanup",
        processed: index,
        total: mismatch.shardMismatches.length,
        currentShard: String(shardInfo.shardId),
      });

      const archivePath = await tursoShardManager.archiveShard(shardInfo.shardId, "fresh-start");
      if (!archivePath) {
        throw new Error(`Migration source shard ${shardInfo.shardId} no longer exists`);
      }
      log("Migration: archived shard for fresh start", {
        shardId: shardInfo.shardId,
        archivePath,
      });
      deletedShards++;
    }

    this.reportProgress({
      phase: "complete",
      processed: mismatch.shardMismatches.length,
      total: mismatch.shardMismatches.length,
    });

    return {
      success: true,
      strategy: "fresh-start",
      deletedShards,
      reEmbeddedMemories: 0,
      duration: Date.now() - startTime,
    };
  }

  private async reEmbedMigration(
    mismatch: DimensionMismatch,
    startTime: number
  ): Promise<MigrationResult> {
    await embeddingService.warmup();
    embeddingService.clearCache();

    const totalMemories = mismatch.shardMismatches.reduce(
      (sum, shard) => sum + shard.vectorCount,
      0
    );

    this.reportProgress({
      phase: "preparing",
      processed: 0,
      total: totalMemories,
    });

    let reEmbeddedCount = 0;
    let processedCount = 0;

    for (const shardInfo of mismatch.shardMismatches) {
      this.reportProgress({
        phase: "re-embedding",
        processed: processedCount,
        total: totalMemories,
        currentShard: String(shardInfo.shardId),
      });

      const shard = await tursoShardManager.getShardById(shardInfo.shardId);
      if (!shard) {
        throw new Error(`Migration source shard ${shardInfo.shardId} no longer exists`);
      }

      const migrated = await tursoShardManager.withScopeWriteLock(
        shard.scope,
        shard.scopeHash,
        () =>
          this.rebuildShardSafely(shard, (processed) => {
            processedCount++;
            this.reportProgress({
              phase: "re-embedding",
              processed: processedCount,
              total: totalMemories,
              currentShard: String(shardInfo.shardId),
            });
            log("Migration: memory staged for re-embed", {
              shardId: shardInfo.shardId,
              memoryId: processed,
            });
          })
      );
      reEmbeddedCount += migrated;
    }

    this.reportProgress({
      phase: "complete",
      processed: totalMemories,
      total: totalMemories,
    });

    return {
      success: true,
      strategy: "re-embed",
      deletedShards: 0,
      reEmbeddedMemories: reEmbeddedCount,
      duration: Date.now() - startTime,
    };
  }

  private async rebuildShardSafely(
    shard: ShardInfo,
    onProcessed: (memoryId: string) => void
  ): Promise<number> {
    const sourceDb = await tursoConnectionManager.getConnection(shard.dbPath);
    const memories = await sourceDb.all(`
      SELECT
        id, content, container_tag, tags, type, created_at, updated_at, metadata,
        display_name, user_name, user_email, project_path, project_name, git_repo_url, is_pinned
      FROM memories
      ORDER BY created_at DESC
    `);
    const nonce = `${process.pid}-${Date.now()}`;
    const stagedPath = `${shard.dbPath}.reembed-${nonce}.tmp`;
    const backupPath = `${shard.dbPath}.pre-reembed-${nonce}.bak`;
    const swapStatePath = `${shard.dbPath}.reembed-swap.json`;

    try {
      const stagedDb = await tursoConnectionManager.getConnection(stagedPath);
      await tursoShardManager.initShardDb(stagedDb);

      // Stage bounded batches. Model or database failures only discard this
      // temporary shard; the source is not touched until full verification.
      const batchSize = 50;
      for (let offset = 0; offset < memories.length; offset += batchSize) {
        const stagedBatch: Array<{ record: MemoryRecord; isPinned: boolean }> = [];
        for (const memory of memories.slice(offset, offset + batchSize)) {
          const content = String(memory.content);
          const tags = memory.tags
            ? String(memory.tags)
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean)
            : [];
          const embeddingInput = tags.length > 0 ? `${content}\nTags: ${tags.join(", ")}` : content;
          const vector = await embeddingService.embedWithTimeout(embeddingInput);
          const tagsVector =
            tags.length > 0
              ? await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags))
              : undefined;

          stagedBatch.push({
            record: {
              id: String(memory.id),
              content,
              vector,
              tagsVector,
              containerTag: String(memory.container_tag),
              tags: memory.tags ? String(memory.tags) : undefined,
              type: memory.type ? String(memory.type) : undefined,
              createdAt: Number(memory.created_at),
              updatedAt: Number(memory.updated_at),
              metadata: memory.metadata ? String(memory.metadata) : undefined,
              displayName: memory.display_name ? String(memory.display_name) : undefined,
              userName: memory.user_name ? String(memory.user_name) : undefined,
              userEmail: memory.user_email ? String(memory.user_email) : undefined,
              projectPath: memory.project_path ? String(memory.project_path) : undefined,
              projectName: memory.project_name ? String(memory.project_name) : undefined,
              gitRepoUrl: memory.git_repo_url ? String(memory.git_repo_url) : undefined,
            },
            isPinned: Number(memory.is_pinned ?? 0) === 1,
          });
          onProcessed(String(memory.id));
        }

        await stagedDb.transaction("write", async (tx) => {
          for (const item of stagedBatch) {
            await tursoVectorSearch.insertVectorInTransaction(tx, item.record);
            if (item.isPinned) {
              await tx.execute({
                sql: `UPDATE memories SET is_pinned = 1 WHERE id = ?`,
                args: [item.record.id],
              });
            }
          }
        });
      }

      const countRow = await stagedDb.get(`SELECT COUNT(*) AS count FROM memories`);
      const stagedCount = Number(countRow?.count ?? 0);
      if (stagedCount !== memories.length) {
        throw new Error(
          `Migration staged count mismatch for shard ${shard.id}: expected ${memories.length}, got ${stagedCount}`
        );
      }

      await tursoConnectionManager.closeConnection(stagedPath);
      writeFileSync(
        swapStatePath,
        JSON.stringify({ dbPath: shard.dbPath, stagedPath, backupPath }),
        "utf-8"
      );
      await tursoConnectionManager.closeConnection(shard.dbPath);
      renameSync(shard.dbPath, backupPath);
      try {
        renameSync(stagedPath, shard.dbPath);
      } catch (error) {
        renameSync(backupPath, shard.dbPath);
        throw error;
      }

      await tursoShardManager.setVectorCount(shard.id, stagedCount);
      unlinkSync(swapStatePath);
      log("Migration: safely replaced re-embedded shard", {
        shardId: shard.id,
        memories: stagedCount,
        backupPath,
      });
      return stagedCount;
    } catch (error) {
      await tursoConnectionManager.closeConnection(stagedPath);
      if (existsSync(stagedPath)) {
        unlinkSync(stagedPath);
      }
      if (existsSync(swapStatePath) && existsSync(shard.dbPath)) {
        unlinkSync(swapStatePath);
      }
      throw error;
    }
  }

  private reportProgress(progress: MigrationProgress): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      configModel: CONFIG.embeddingModel,
      configDimensions: CONFIG.embeddingDimensions,
    };
  }
}

export const migrationService = new MigrationService();
