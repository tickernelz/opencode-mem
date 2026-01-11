import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface CleanupResult {
  deletedCount: number;
  userCount: number;
  projectCount: number;
  promptsDeleted: number;
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
      log("Cleanup: starting", { retentionDays: CONFIG.autoCleanupRetentionDays });

      const cutoffTime = Date.now() - CONFIG.autoCleanupRetentionDays * 24 * 60 * 60 * 1000;

      const promptsDeleted = userPromptManager.deleteOldPrompts(cutoffTime);

      const userShards = shardManager.getAllShards("user", "");
      const projectShards = shardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      let totalDeleted = 0;
      let userDeleted = 0;
      let projectDeleted = 0;

      for (const shard of allShards) {
        const db = connectionManager.getConnection(shard.dbPath);

        const oldMemories = db
          .prepare(
            `
          SELECT id, container_tag FROM memories 
          WHERE updated_at < ? AND is_pinned = 0
        `
          )
          .all(cutoffTime) as any[];

        if (oldMemories.length === 0) continue;

        for (const memory of oldMemories) {
          try {
            vectorSearch.deleteVector(db, memory.id);
            shardManager.decrementVectorCount(shard.id);
            totalDeleted++;

            if (memory.container_tag?.includes("_user_")) {
              userDeleted++;
            } else if (memory.container_tag?.includes("_project_")) {
              projectDeleted++;
            }
          } catch (error) {
            log("Cleanup: delete error", { memoryId: memory.id, error: String(error) });
          }
        }
      }

      log("Cleanup: completed", {
        totalDeleted,
        userDeleted,
        projectDeleted,
        promptsDeleted,
        cutoffTime: new Date(cutoffTime).toISOString(),
      });

      return {
        deletedCount: totalDeleted,
        userCount: userDeleted,
        projectCount: projectDeleted,
        promptsDeleted,
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
