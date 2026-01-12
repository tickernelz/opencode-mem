import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";

interface DuplicateGroup {
  representative: {
    id: string;
    content: string;
    containerTag: string;
    createdAt: number;
  };
  duplicates: Array<{
    id: string;
    content: string;
    similarity: number;
  }>;
}

interface DeduplicationResult {
  exactDuplicatesDeleted: number;
  nearDuplicateGroups: DuplicateGroup[];
}

export class DeduplicationService {
  private isRunning: boolean = false;

  async detectAndRemoveDuplicates(): Promise<DeduplicationResult> {
    if (this.isRunning) {
      throw new Error("Deduplication already running");
    }

    if (!CONFIG.deduplicationEnabled) {
      throw new Error("Deduplication is disabled in config");
    }

    this.isRunning = true;

    try {
      log("Deduplication: starting", {
        threshold: CONFIG.deduplicationSimilarityThreshold,
      });

      const userShards = shardManager.getAllShards("user", "");
      const projectShards = shardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      let exactDeleted = 0;
      const nearDuplicateGroups: DuplicateGroup[] = [];

      for (const shard of allShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.getAllMemories(db);

        const contentMap = new Map<string, any[]>();

        for (const memory of memories) {
          const key = `${memory.container_tag}:${memory.content}`;
          if (!contentMap.has(key)) {
            contentMap.set(key, []);
          }
          contentMap.get(key)!.push(memory);
        }

        for (const [, duplicates] of contentMap) {
          if (duplicates.length > 1) {
            duplicates.sort((a, b) => Number(b.created_at) - Number(a.created_at));
            const toDelete = duplicates.slice(1);

            for (const dup of toDelete) {
              try {
                vectorSearch.deleteVector(db, dup.id);
                shardManager.decrementVectorCount(shard.id);
                exactDeleted++;
              } catch (error) {
                log("Deduplication: delete error", {
                  memoryId: dup.id,
                  error: String(error),
                });
              }
            }
          }
        }

        const uniqueMemories = Array.from(contentMap.values()).map((arr) => arr[0]);

        for (let i = 0; i < uniqueMemories.length; i++) {
          const mem1 = uniqueMemories[i];
          if (!mem1.vector) continue;

          const vector1 = new Float32Array(new Uint8Array(mem1.vector).buffer);
          const similarGroup: DuplicateGroup = {
            representative: {
              id: mem1.id,
              content: mem1.content,
              containerTag: mem1.container_tag,
              createdAt: mem1.created_at,
            },
            duplicates: [],
          };

          for (let j = i + 1; j < uniqueMemories.length; j++) {
            const mem2 = uniqueMemories[j];
            if (!mem2.vector) continue;
            if (mem1.container_tag !== mem2.container_tag) continue;

            const vector2 = new Float32Array(new Uint8Array(mem2.vector).buffer);
            const similarity = this.cosineSimilarity(vector1, vector2);

            if (similarity >= CONFIG.deduplicationSimilarityThreshold && similarity < 1.0) {
              similarGroup.duplicates.push({
                id: mem2.id,
                content: mem2.content,
                similarity,
              });
            }
          }

          if (similarGroup.duplicates.length > 0) {
            nearDuplicateGroups.push(similarGroup);
          }
        }
      }

      log("Deduplication: completed", {
        exactDeleted,
        nearDuplicateGroupsFound: nearDuplicateGroups.length,
      });

      return {
        exactDuplicatesDeleted: exactDeleted,
        nearDuplicateGroups,
      };
    } finally {
      this.isRunning = false;
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] || 0;
      const bVal = b[i] || 0;
      dotProduct += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getStatus() {
    return {
      enabled: CONFIG.deduplicationEnabled,
      threshold: CONFIG.deduplicationSimilarityThreshold,
      isRunning: this.isRunning,
    };
  }
}

export const deduplicationService = new DeduplicationService();
