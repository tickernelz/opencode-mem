import { DatabaseFactory } from "./database/factory.js";
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
      const adapter = DatabaseFactory.getCached();
      if (!adapter) {
        throw new Error("Database adapter not initialized");
      }

      const vectorSearch = adapter.getVectorSearch();
      const cutoffTime = Date.now() - CONFIG.autoCleanupRetentionDays * 24 * 60 * 60 * 1000;

      // Get all memories to check for old ones
      const allMemories = await vectorSearch.getAllMemories();

      // Get protected memory IDs from prompts
      const promptCleanupResult = await userPromptManager.deleteOldPrompts(cutoffTime);
      const linkedMemoryIds = new Set(promptCleanupResult.linkedMemoryIds);

      let totalDeleted = 0;
      let userDeleted = 0;
      let projectDeleted = 0;
      let linkedMemoriesDeleted = 0;
      let pinnedSkipped = 0;

      // Process each memory
      for (const memory of allMemories) {
        try {
          // Skip if memory is newer than cutoff
          const updatedAt = typeof memory.updated_at === "number"
            ? memory.updated_at
            : memory.updated_at.getTime();
          if (updatedAt >= cutoffTime) {
            continue;
          }

          // Skip pinned memories
          if (memory.is_pinned === 1) {
            pinnedSkipped++;
            continue;
          }

          // Skip if linked to a prompt
          if (linkedMemoryIds.has(memory.id)) {
            continue;
          }

          // Delete the memory
          const deleted = await vectorSearch.deleteMemory(memory.id);
          if (deleted) {
            totalDeleted++;

            if (memory.container_tag?.includes("_user_")) {
              userDeleted++;
            } else if (memory.container_tag?.includes("_project_")) {
              projectDeleted++;
            }

            // Decrement shard count only in SQLite mode
            if (CONFIG.databaseType === "sqlite") {
              const shardManager = adapter.getShardManager();
              // SQLite-specific: decrement vector count
              // Note: We'd need to track shard ID per memory, which isn't available here
              // This is a limitation of the abstraction - for now, skip this
            }
          }
        } catch (error) {
          log("Cleanup: delete error", { memoryId: memory.id, error: String(error) });
        }
      }

      const promptsDeleted = promptCleanupResult.deleted - linkedMemoryIds.size;

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
