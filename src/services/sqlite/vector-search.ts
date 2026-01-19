import { Database } from "bun:sqlite";
import { connectionManager } from "./connection-manager.js";
import { log } from "../logger.js";
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";

export class VectorSearch {
  insertVector(db: Database, record: MemoryRecord): void {
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
    limit: number
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

    const scoreMap = new Map<string, { contentDist: number; tagsDist: number }>();

    for (const r of contentResults) {
      scoreMap.set(r.memory_id, { contentDist: r.distance, tagsDist: 1 });
    }

    for (const r of tagsResults) {
      const entry = scoreMap.get(r.memory_id) || { contentDist: 1, tagsDist: 1 };
      entry.tagsDist = r.distance;
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

    return rows.map((row: any) => {
      const scores = scoreMap.get(row.id)!;
      const contentSim = 1 - scores.contentDist;
      const tagsSim = 1 - scores.tagsDist;
      const similarity = tagsSim * 0.8 + contentSim * 0.2;

      return {
        id: row.id,
        memory: row.content,
        similarity,
        tags: row.tags ? row.tags.split(",").map((t: string) => t.trim()) : [],
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
    similarityThreshold: number
  ): Promise<SearchResult[]> {
    const allResults: SearchResult[] = [];

    for (const shard of shards) {
      try {
        const results = this.searchInShard(shard, queryVector, containerTag, limit);
        allResults.push(...results);
      } catch (error) {
        log("Shard search error", { shardId: shard.id, error: String(error) });
      }
    }

    allResults.sort((a, b) => b.similarity - a.similarity);
    return allResults.filter((r) => r.similarity >= similarityThreshold).slice(0, limit);
  }

  deleteVector(db: Database, memoryId: string): void {
    db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(memoryId);
    db.prepare(`DELETE FROM vec_tags WHERE memory_id = ?`).run(memoryId);
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
  }

  listMemories(db: Database, containerTag: string, limit: number): any[] {
    const stmt = db.prepare(`
      SELECT * FROM memories 
      WHERE container_tag = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(containerTag, limit) as any[];
  }

  getAllMemories(db: Database): any[] {
    const stmt = db.prepare(`SELECT * FROM memories ORDER BY created_at DESC`);
    return stmt.all() as any[];
  }

  getMemoryById(db: Database, memoryId: string): any | null {
    const stmt = db.prepare(`SELECT * FROM memories WHERE id = ?`);
    return stmt.get(memoryId) as any;
  }

  countVectors(db: Database, containerTag: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ?`);
    const result = stmt.get(containerTag) as any;
    return result.count;
  }

  countAllVectors(db: Database): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories`);
    const result = stmt.get() as any;
    return result.count;
  }

  getDistinctTags(db: Database): any[] {
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

  pinMemory(db: Database, memoryId: string): void {
    const stmt = db.prepare(`UPDATE memories SET is_pinned = 1 WHERE id = ?`);
    stmt.run(memoryId);
  }

  unpinMemory(db: Database, memoryId: string): void {
    const stmt = db.prepare(`UPDATE memories SET is_pinned = 0 WHERE id = ?`);
    stmt.run(memoryId);
  }
}

export const vectorSearch = new VectorSearch();
