import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { isVacuumUnsupportedError } from "./turso/error-classifiers.js";
import { ensureTursoReady } from "./turso/ready.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface CleanupResult {
  deletedCount: number;
  userCount: number;
  projectCount: number;
  promptsDeleted: number;
  linkedMemoriesDeleted: number;
  pinnedMemoriesSkipped: number;
  aiSessionsDeleted: number;
}

/** Process-lifetime: Turso rejected VACUUM; do not retry every cleanup. */
let vacuumUnsupported = false;

export class CleanupService {
  private lastCleanupTime: number = 0;
  private isRunning: boolean = false;

  async shouldRunCleanup(): Promise<boolean> {
    if (!CONFIG.autoCleanupEnabled) return false;
    if (this.isRunning) return false;

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    if (now - this.lastCleanupTime < oneDayMs) {
      return false;
    }

    return true;
  }

  async runCleanup(): Promise<CleanupResult> {
    if (this.isRunning) {
      throw new Error("Cleanup already running");
    }

    this.isRunning = true;
    this.lastCleanupTime = Date.now();

    try {
      await ensureTursoReady();
      const cutoffTime = Date.now() - CONFIG.autoCleanupRetentionDays * 24 * 60 * 60 * 1000;

      let allShards: Awaited<ReturnType<typeof tursoShardManager.getAllShards>> = [];
      try {
        const userShards = await tursoShardManager.getAllShards("user", "");
        const projectShards = await tursoShardManager.getAllShards("project", "");
        allShards = [...userShards, ...projectShards];
      } catch (error) {
        log("Cleanup: step failed", { step: "list-shards", error: String(error) });
      }

      const pinnedMemoryIds = new Set<string>();
      for (const shard of allShards) {
        try {
          const db = await tursoConnectionManager.getConnection(shard.dbPath);
          const pinned = await db.all(`SELECT id FROM memories WHERE is_pinned = 1`);
          pinned.forEach((row) => pinnedMemoryIds.add(String(row.id)));
        } catch (error) {
          log("Cleanup: step failed", {
            step: "pins",
            shardId: shard.id,
            error: String(error),
          });
        }
      }

      let promptCleanupResult = { deleted: 0, linkedMemoryIds: [] as string[] };
      try {
        promptCleanupResult = await userPromptManager.deleteOldPrompts(cutoffTime);
      } catch (error) {
        log("Cleanup: step failed", { step: "deleteOldPrompts", error: String(error) });
      }
      const linkedMemoryIds = new Set(promptCleanupResult.linkedMemoryIds);
      const protectedMemoryIds = new Set([...pinnedMemoryIds, ...linkedMemoryIds]);

      let totalDeleted = 0;
      let userDeleted = 0;
      let projectDeleted = 0;
      const linkedMemoriesDeleted = 0;
      let pinnedSkipped = 0;

      for (const shard of allShards) {
        let db;
        try {
          db = await tursoConnectionManager.getConnection(shard.dbPath);
          await tursoShardManager.ensureShardSchema(db);
        } catch (error) {
          log("Cleanup: step failed", {
            step: "shard-schema",
            shardId: shard.id,
            error: String(error),
          });
          continue;
        }

        let oldMemories: Array<Record<string, unknown>> = [];
        try {
          oldMemories = await db.all(
            `
          SELECT id, container_tag, is_pinned FROM memories
          WHERE updated_at < ? AND deleted_at IS NULL
        `,
            [cutoffTime]
          );
        } catch (error) {
          log("Cleanup: step failed", {
            step: "age-select",
            shardId: shard.id,
            error: String(error),
          });
          continue;
        }

        for (const memory of oldMemories) {
          try {
            if (Number(memory.is_pinned) === 1) {
              pinnedSkipped++;
              continue;
            }

            if (protectedMemoryIds.has(String(memory.id))) {
              continue;
            }

            await tursoVectorSearch.deleteVector(db, String(memory.id));
            await tursoShardManager.decrementVectorCount(shard.id);
            totalDeleted++;

            if (String(memory.container_tag).includes("_user_")) {
              userDeleted++;
            } else if (String(memory.container_tag).includes("_project_")) {
              projectDeleted++;
            }
          } catch (error) {
            log("Cleanup: delete error", { memoryId: memory.id, error: String(error) });
          }
        }

        // Hard-purge soft-deleted trash past retention.
        const trashCutoff = Date.now() - CONFIG.dreaming.trashRetentionDays * 24 * 60 * 60 * 1000;
        try {
          const purged = await tursoVectorSearch.purgeDeletedBefore(db, trashCutoff);
          for (const _id of purged) {
            await tursoShardManager.decrementVectorCount(shard.id);
            totalDeleted++;
          }
          if (purged.length > 0) {
            log("Cleanup: purged trash", { count: purged.length, shardId: shard.id });
          }
        } catch (error) {
          log("Cleanup: trash purge error", { shardId: shard.id, error: String(error) });
        }
      }

      const promptsDeleted = promptCleanupResult.deleted - linkedMemoryIds.size;

      if (!vacuumUnsupported) {
        try {
          await userPromptManager.vacuum();
          log("Cleanup: VACUUM done", { db: "user-prompts.db" });
        } catch (err) {
          if (isVacuumUnsupportedError(err)) {
            vacuumUnsupported = true;
            log("Cleanup: VACUUM skipped (unsupported by Turso backend)", {
              error: String(err),
            });
          } else {
            log("Cleanup: VACUUM skipped (DB busy)", { error: String(err) });
          }
        }
      }

      let aiSessionsDeleted = 0;
      try {
        const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
        aiSessionsDeleted = await AIProviderFactory.cleanupExpiredSessions();
        log("Cleanup: expired AI sessions deleted", { aiSessionsDeleted });
      } catch (err) {
        log("Cleanup: AI session cleanup failed", { error: String(err) });
      }

      return {
        deletedCount: totalDeleted,
        userCount: userDeleted,
        projectCount: projectDeleted,
        promptsDeleted,
        linkedMemoriesDeleted,
        pinnedMemoriesSkipped: pinnedSkipped,
        aiSessionsDeleted,
      };
    } finally {
      this.isRunning = false;
    }
  }

  getStatus() {
    return {
      enabled: CONFIG.autoCleanupEnabled,
      retentionDays: CONFIG.autoCleanupRetentionDays,
      lastCleanupTime: this.lastCleanupTime,
      isRunning: this.isRunning,
    };
  }
}

export const cleanupService = new CleanupService();

/** Test helper: reset process-lifetime VACUUM unsupported flag. */
export function resetVacuumUnsupportedForTests(): void {
  vacuumUnsupported = false;
}
