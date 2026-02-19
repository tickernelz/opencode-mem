import { getDatabase } from "./sqlite-bootstrap.js";
import { connectionManager } from "./connection-manager.js";
import { log } from "../logger.js";
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";

const Database = getDatabase();
type DatabaseType = typeof Database.prototype;

export class VectorSearch {
  insertVector(db: DatabaseType, record: MemoryRecord): void {
    const insertMemory = db.prepare(`
      INSERT INTO memories (
        id, content, vector, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const vectorBuffer = new Uint8Array(record.vector.buffer);

    insertMemory.run(
      record.id,
      record.content,
      vectorBuffer,
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

    const insertVec = db.prepare(`
      INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)
    `);
    insertVec.run(record.id, vectorBuffer);

    if (record.tagsVector) {
      const tagsVectorBuffer = new Uint8Array(record.tagsVector.buffer);
      const insertTagsVec = db.prepare(`
        INSERT INTO vec_tags (memory_id, embedding) VALUES (?, ?)
      `);
      insertTagsVec.run(record.id, tagsVectorBuffer);
    }
  }

  searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    queryText?: string
  ): SearchResult[] {
    const db = connectionManager.getConnection(shard.dbPath);
    const queryBuffer = new Uint8Array(queryVector.buffer);

    const contentResults = db
      .prepare(
        `
      SELECT memory_id, distance FROM vec_memories 
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `
      )
      .all(queryBuffer, limit * 4) as any[];

    const tagsResults = db
      .prepare(
        `
      SELECT memory_id, distance FROM vec_tags 
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `
      )
      .all(queryBuffer, limit * 4) as any[];

    const scoreMap = new Map<string, { contentSim: number; tagsSim: number }>();

    for (const r of contentResults) {
      scoreMap.set(r.memory_id, { contentSim: 1 - r.distance, tagsSim: 0 });
    }

    for (const r of tagsResults) {
      const entry = scoreMap.get(r.memory_id) || { contentSim: 0, tagsSim: 0 };
      entry.tagsSim = 1 - r.distance;
      scoreMap.set(r.memory_id, entry);
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

      const tagSim = Math.max(scores.tagsSim, exactMatchBoost);
      const similarity = tagSim * 0.8 + scores.contentSim * 0.2;

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
        return this.searchInShard(shard, queryVector, containerTag, limit, queryText);
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

  deleteVector(db: DatabaseType, memoryId: string): void {
    db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(memoryId);
    db.prepare(`DELETE FROM vec_tags WHERE memory_id = ?`).run(memoryId);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
  }

  updateVector(
    db: DatabaseType,
    memoryId: string,
    vector: Float32Array,
    tagsVector?: Float32Array
  ): void {
    const vectorBuffer = new Uint8Array(vector.buffer);
    db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(memoryId);
    db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`).run(
      memoryId,
      vectorBuffer
    );

    if (tagsVector) {
      const tagsVectorBuffer = new Uint8Array(tagsVector.buffer);
      db.prepare(`DELETE FROM vec_tags WHERE memory_id = ?`).run(memoryId);
      db.prepare(`INSERT INTO vec_tags (memory_id, embedding) VALUES (?, ?)`).run(
        memoryId,
        tagsVectorBuffer
      );
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
}

export const vectorSearch = new VectorSearch();
