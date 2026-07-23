import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { parseExtractedVector } from "./turso/vector-utils.js";

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
      await ensureTursoReady();
      const userShards = await tursoShardManager.getAllShards("user", "");
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      let exactDeleted = 0;
      const nearDuplicateGroups: DuplicateGroup[] = [];

      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.getAllMemoriesWithExtractedVectors(db);

        const contentMap = new Map<string, (typeof memories)[number][]>();

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
                await tursoVectorSearch.deleteVector(db, String(dup.id));
                await tursoShardManager.decrementVectorCount(shard.id);
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

        const uniqueMemories = Array.from(contentMap.values()).map((arr) => arr[0]!);
        const processedIds = new Set<string>();

        for (let i = 0; i < uniqueMemories.length; i++) {
          const mem1 = uniqueMemories[i]!;
          const vector1 = parseExtractedVector(mem1.vector_json);
          if (!vector1 || processedIds.has(String(mem1.id))) continue;

          const similarGroup: DuplicateGroup = {
            representative: {
              id: String(mem1.id),
              content: String(mem1.content),
              containerTag: String(mem1.container_tag),
              createdAt: Number(mem1.created_at),
            },
            duplicates: [],
          };

          for (let j = i + 1; j < uniqueMemories.length; j++) {
            const mem2 = uniqueMemories[j]!;
            const vector2 = parseExtractedVector(mem2.vector_json);
            if (!vector2 || processedIds.has(String(mem2.id))) continue;
            if (mem1.container_tag !== mem2.container_tag) continue;

            const similarity = cosineSimilarity(vector1, vector2);

            if (similarity >= CONFIG.deduplicationSimilarityThreshold && similarity < 1.0) {
              similarGroup.duplicates.push({
                id: String(mem2.id),
                content: String(mem2.content),
                similarity,
              });
              processedIds.add(String(mem2.id));
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

  getStatus() {
    return {
      enabled: CONFIG.deduplicationEnabled,
      threshold: CONFIG.deduplicationSimilarityThreshold,
      isRunning: this.isRunning,
    };
  }
}

export const deduplicationService = new DeduplicationService();
