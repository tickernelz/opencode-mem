import { getDatabase } from "./sqlite-bootstrap.js";
import { connectionManager } from "./connection-manager.js";
import { HNSWIndexManager } from "./hnsw-index.js";
import { log } from "../logger.js";
import { CONFIG } from "../../config.js";
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";

const Database = getDatabase();
type DatabaseType = typeof Database.prototype;

const hnswIndexManager = new HNSWIndexManager(CONFIG.storagePath);

export class VectorSearch {
  insertVector(db: DatabaseType, record: MemoryRecord, shard?: ShardInfo): void {
    const insertMemory = db.prepare(`
      INSERT INTO memories (
        id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const vectorBuffer = new Uint8Array(record.vector.buffer);
    const tagsVectorBuffer = record.tagsVector ? new Uint8Array(record.tagsVector.buffer) : null;

    insertMemory.run(
      record.id,
      record.content,
      vectorBuffer,
      tagsVectorBuffer,
      record.containerTag,
      record.tags || null,
      record.type || null,
      record.createdAt,
      record.updatedAt,
      record.metadata || null,
      record.displayName || null,
      record.userName || null,
      record.userEmail || null,
      record.projectPath || null,
      record.projectName || null,
      record.gitRepoUrl || null
    );

    if (shard && record.vector) {
      const contentIndex = hnswIndexManager.getIndex(
        shard.scope,
        shard.scopeHash,
        shard.shardIndex
      );
      contentIndex.insert(record.id, record.vector).catch((err) => {
        log("HNSW content insert error", { memoryId: record.id, error: String(err) });
      });

      if (record.tagsVector) {
        const tagsIndex = hnswIndexManager.getTagsIndex(
          shard.scope,
          shard.scopeHash,
          shard.shardIndex
        );
        tagsIndex.insert(record.id, record.tagsVector).catch((err) => {
          log("HNSW tags insert error", { memoryId: record.id, error: String(err) });
        });
      }
    }
  }

  async searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    const db = connectionManager.getConnection(shard.dbPath);
    const contentIndex = hnswIndexManager.getIndex(shard.scope, shard.scopeHash, shard.shardIndex);
    const tagsIndex = hnswIndexManager.getTagsIndex(shard.scope, shard.scopeHash, shard.shardIndex);

    const contentResults = await contentIndex.search(queryVector, limit * 4);
    const tagsResults = await tagsIndex.search(queryVector, limit * 4);

    const scoreMap = new Map<string, { contentSim: number; tagsSim: number }>();

    for (const r of contentResults) {
      scoreMap.set(r.id, { contentSim: 1 - r.distance, tagsSim: 0 });
    }

    for (const r of tagsResults) {
      const entry = scoreMap.get(r.id);
      if (entry) {
        entry.tagsSim = 1 - r.distance;
      } else {
        scoreMap.set(r.id, { contentSim: 0, tagsSim: 1 - r.distance });
      }
    }

    const ids = Array.from(scoreMap.keys());
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `
      SELECT * FROM memories 
      WHERE id IN (${placeholders}) AND container_tag = ?
    `
      )
      .all(...ids, containerTag) as any[];

    const queryWords = queryText
      ? queryText
          .toLowerCase()
          .split(/[\s,]+/)
          .filter((w) => w.length > 1)
      : [];

    return rows.map((row: any) => {
      const scores = scoreMap.get(row.id)!;
      const memoryTagsStr = row.tags || "";
      const memoryTags = memoryTagsStr.split(",").map((t: string) => t.trim().toLowerCase());

      let exactMatchBoost = 0;
      if (queryWords.length > 0 && memoryTags.length > 0) {
        const matches = queryWords.filter((w) =>
          memoryTags.some((t: string) => t.includes(w) || w.includes(t))
        ).length;
        exactMatchBoost = matches / Math.max(queryWords.length, 1);
      }

      const finalTagsSim = Math.max(scores.tagsSim, exactMatchBoost);
      const similarity = scores.contentSim * 0.6 + finalTagsSim * 0.4;

      return {
        id: row.id,
        memory: row.content,
        similarity,
        tags: memoryTagsStr ? memoryTagsStr.split(",") : [],
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        containerTag: row.container_tag,
        displayName: row.display_name,
        userName: row.user_name,
        userEmail: row.user_email,
        projectPath: row.project_path,
        projectName: row.project_name,
        gitRepoUrl: row.git_repo_url,
        isPinned: row.is_pinned,
      };
    });
  }

  async searchAcrossShards(
    shards: ShardInfo[],
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    const shardPromises = shards.map(async (shard) => {
      try {
        return await this.searchInShard(shard, queryVector, containerTag, limit, queryText);
      } catch (error) {
        log("Shard search error", { shardId: shard.id, error: String(error) });
        return [];
      }
    });

    const resultsArray = await Promise.all(shardPromises);
    const allResults = resultsArray.flat();

    allResults.sort((a, b) => b.similarity - a.similarity);
    return allResults.filter((r) => r.similarity >= similarityThreshold).slice(0, limit);
  }

  async deleteVector(db: DatabaseType, memoryId: string, shard?: ShardInfo): Promise<void> {
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);

    if (shard) {
      const contentIndex = hnswIndexManager.getIndex(
        shard.scope,
        shard.scopeHash,
        shard.shardIndex
      );
      const tagsIndex = hnswIndexManager.getTagsIndex(
        shard.scope,
        shard.scopeHash,
        shard.shardIndex
      );
      await Promise.all([contentIndex.delete(memoryId), tagsIndex.delete(memoryId)]);
    }
  }

  async updateVector(
    db: DatabaseType,
    memoryId: string,
    vector: Float32Array,
    shard?: ShardInfo,
    tagsVector?: Float32Array
  ): Promise<void> {
    const vectorBuffer = new Uint8Array(vector.buffer);
    const tagsVectorBuffer = tagsVector ? new Uint8Array(tagsVector.buffer) : null;
    db.prepare(`UPDATE memories SET vector = ?, tags_vector = ? WHERE id = ?`).run(
      vectorBuffer,
      tagsVectorBuffer,
      memoryId
    );

    if (shard && vector) {
      const contentIndex = hnswIndexManager.getIndex(
        shard.scope,
        shard.scopeHash,
        shard.shardIndex
      );
      await contentIndex.insert(memoryId, vector);

      if (tagsVector) {
        const tagsIndex = hnswIndexManager.getTagsIndex(
          shard.scope,
          shard.scopeHash,
          shard.shardIndex
        );
        await tagsIndex.insert(memoryId, tagsVector);
      }
    }
  }

  listMemories(db: DatabaseType, containerTag: string, limit: number): any[] {
    const stmt = db.prepare(`
      SELECT * FROM memories 
      WHERE container_tag = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(containerTag, limit) as any[];
  }

  getAllMemories(db: DatabaseType): any[] {
    const stmt = db.prepare(`SELECT * FROM memories ORDER BY created_at DESC`);
    return stmt.all() as any[];
  }

  getMemoryById(db: DatabaseType, memoryId: string): any | null {
    const stmt = db.prepare(`SELECT * FROM memories WHERE id = ?`);
    return stmt.get(memoryId) as any;
  }

  getMemoriesBySessionID(db: DatabaseType, sessionID: string): any[] {
    const stmt = db.prepare(`
      SELECT * FROM memories 
      WHERE metadata LIKE ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(`%"sessionID":"${sessionID}"%`) as any[];

    return rows.map((row: any) => ({
      ...row,
      tags: row.tags ? row.tags.split(",") : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }));
  }

  countVectors(db: DatabaseType, containerTag: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ?`);
    const result = stmt.get(containerTag) as any;
    return result.count;
  }

  countAllVectors(db: DatabaseType): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories`);
    const result = stmt.get() as any;
    return result.count;
  }

  getDistinctTags(db: DatabaseType): any[] {
    const stmt = db.prepare(`
      SELECT DISTINCT 
        container_tag,
        display_name,
        user_name,
        user_email,
        project_path,
        project_name,
        git_repo_url
      FROM memories
    `);
    return stmt.all() as any[];
  }

  pinMemory(db: DatabaseType, memoryId: string): void {
    const stmt = db.prepare(`UPDATE memories SET is_pinned = 1 WHERE id = ?`);
    stmt.run(memoryId);
  }

  unpinMemory(db: DatabaseType, memoryId: string): void {
    const stmt = db.prepare(`UPDATE memories SET is_pinned = 0 WHERE id = ?`);
    stmt.run(memoryId);
  }

  async rebuildHNSWIndex(
    db: DatabaseType,
    scope: string,
    scopeHash: string,
    shardIndex: number
  ): Promise<void> {
    await hnswIndexManager.rebuildFromShard(db, scope, scopeHash, shardIndex);
  }

  getIndexManager(): HNSWIndexManager {
    return hnswIndexManager;
  }
}

export const vectorSearch = new VectorSearch();
