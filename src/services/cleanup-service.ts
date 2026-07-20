import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
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
}

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

      const userShards = await tursoShardManager.getAllShards("user", "");
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      const pinnedMemoryIds = new Set<string>();
      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const pinned = await db.all(`SELECT id FROM memories WHERE is_pinned = 1`);
        pinned.forEach((row) => pinnedMemoryIds.add(String(row.id)));
      }

      const promptCleanupResult = await userPromptManager.deleteOldPrompts(cutoffTime);
      const linkedMemoryIds = new Set(promptCleanupResult.linkedMemoryIds);
      const protectedMemoryIds = new Set([...pinnedMemoryIds, ...linkedMemoryIds]);

      let totalDeleted = 0;
      let userDeleted = 0;
      let projectDeleted = 0;
      const linkedMemoriesDeleted = 0;
      let pinnedSkipped = 0;

      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const oldMemories = await db.all(
          `
          SELECT id, container_tag, is_pinned FROM memories
          WHERE updated_at < ?
        `,
          [cutoffTime]
        );

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
      }

      const promptsDeleted = promptCleanupResult.deleted - linkedMemoryIds.size;

      try {
        await userPromptManager.vacuum();
        log("Cleanup: VACUUM done", { db: "user-prompts.db" });
      } catch (err) {
        log("Cleanup: VACUUM skipped (DB busy)", { error: String(err) });
      }

      return {
        deletedCount: totalDeleted,
        userCount: userDeleted,
        projectCount: projectDeleted,
        promptsDeleted,
        linkedMemoriesDeleted,
        pinnedMemoriesSkipped: pinnedSkipped,
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
