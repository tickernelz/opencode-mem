import { DatabaseFactory } from "./database/factory.js";
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
      const adapter = DatabaseFactory.getCached();
      if (!adapter) {
        throw new Error("Database adapter not initialized");
      }

      const vectorSearch = adapter.getVectorSearch();

      let exactDeleted = 0;
      const nearDuplicateGroups: DuplicateGroup[] = [];

      // For SQLite: iterate through shards
      // For PostgreSQL: process all memories at once
      if (CONFIG.databaseType === "sqlite") {
        const shardManager = adapter.getShardManager();
        const userShards = shardManager.getAllShards("user", "");
        const projectShards = shardManager.getAllShards("project", "");
        const allShards = [...userShards, ...projectShards];

        for (const shard of allShards) {
          const memories = await vectorSearch.getAllMemories();

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
                  await vectorSearch.deleteMemory(dup.id);
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
          const processedIds = new Set<string>();

          for (let i = 0; i < uniqueMemories.length; i++) {
            const mem1 = uniqueMemories[i];
            if (!mem1.vector || processedIds.has(mem1.id)) continue;

            const vector1 = this.bufferToFloat32Array(mem1.vector);
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
              if (!mem2.vector || processedIds.has(mem2.id)) continue;
              if (mem1.container_tag !== mem2.container_tag) continue;

              const vector2 = this.bufferToFloat32Array(mem2.vector);
              const similarity = this.cosineSimilarity(vector1, vector2);

              if (similarity >= CONFIG.deduplicationSimilarityThreshold && similarity < 1.0) {
                similarGroup.duplicates.push({
                  id: mem2.id,
                  content: mem2.content,
                  similarity,
                });
                processedIds.add(mem2.id);
              }
            }

            if (similarGroup.duplicates.length > 0) {
              nearDuplicateGroups.push(similarGroup);
            }
          }
        }
      } else {
        // PostgreSQL: no sharding, process all memories
        const memories = await vectorSearch.getAllMemories();

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
                await vectorSearch.deleteMemory(dup.id);
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
        const processedIds = new Set<string>();

        for (let i = 0; i < uniqueMemories.length; i++) {
          const mem1 = uniqueMemories[i];
          if (!mem1.vector || processedIds.has(mem1.id)) continue;

          const vector1 = this.bufferToFloat32Array(mem1.vector);
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
            if (!mem2.vector || processedIds.has(mem2.id)) continue;
            if (mem1.container_tag !== mem2.container_tag) continue;

            const vector2 = this.bufferToFloat32Array(mem2.vector);
            const similarity = this.cosineSimilarity(vector1, vector2);

            if (similarity >= CONFIG.deduplicationSimilarityThreshold && similarity < 1.0) {
              similarGroup.duplicates.push({
                id: mem2.id,
                content: mem2.content,
                similarity,
              });
              processedIds.add(mem2.id);
            }
          }

          if (similarGroup.duplicates.length > 0) {
            nearDuplicateGroups.push(similarGroup);
          }
        }
      }

      return {
        exactDuplicatesDeleted: exactDeleted,
        nearDuplicateGroups,
      };
    } finally {
      this.isRunning = false;
    }
  }

  private bufferToFloat32Array(buffer: any): Float32Array {
    if (buffer instanceof Float32Array) {
      return buffer;
    }
    if (buffer instanceof Uint8Array || Buffer.isBuffer(buffer)) {
      return new Float32Array(new Uint8Array(buffer).buffer);
    }
    if (Array.isArray(buffer)) {
      return new Float32Array(buffer);
    }
    throw new Error("Unsupported vector buffer type");
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
