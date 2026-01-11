import { Database } from "bun:sqlite";
import { connectionManager } from "./connection-manager.js";
import { shardManager } from "./shard-manager.js";
import { log } from "../logger.js";
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class VectorSearch {
  insertVector(db: Database, record: MemoryRecord): void {
    const insertMemory = db.prepare(`
      INSERT INTO memories (
        id, content, vector, container_tag, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const vectorBuffer = new Uint8Array(record.vector.buffer);

    insertMemory.run(
      record.id,
      record.content,
      vectorBuffer,
      record.containerTag,
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
  }

  searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array,
    containerTag: string,
    limit: number
  ): SearchResult[] {
    const db = connectionManager.getConnection(shard.dbPath);

    const stmt = db.prepare(`
      SELECT 
        v.memory_id,
        v.distance,
        m.content,
        m.metadata,
        m.display_name,
        m.user_name,
        m.user_email,
        m.project_path,
        m.project_name,
        m.git_repo_url
      FROM vec_memories v
      INNER JOIN memories m ON v.memory_id = m.id
      WHERE m.container_tag = ?
        AND v.embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `);

    const queryBuffer = new Uint8Array(queryVector.buffer);
    const rows = stmt.all(containerTag, queryBuffer, limit * 2) as any[];

    return rows.map((row: any) => ({
      id: row.memory_id,
      memory: row.content,
      similarity: 1 - row.distance,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      displayName: row.display_name,
      userName: row.user_name,
      userEmail: row.user_email,
      projectPath: row.project_path,
      projectName: row.project_name,
      gitRepoUrl: row.git_repo_url,
    }));
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

    return allResults
      .filter(r => r.similarity >= similarityThreshold)
      .slice(0, limit);
  }

  deleteVector(db: Database, memoryId: string): void {
    const deleteVec = db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`);
    deleteVec.run(memoryId);

    const deleteMemory = db.prepare(`DELETE FROM memories WHERE id = ?`);
    deleteMemory.run(memoryId);
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

  getMemoryById(db: Database, memoryId: string): any | null {
    const stmt = db.prepare(`SELECT * FROM memories WHERE id = ?`);
    return stmt.get(memoryId) as any;
  }

  countVectors(db: Database, containerTag: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ?`);
    const result = stmt.get(containerTag) as any;
    return result.count;
  }
}

export const vectorSearch = new VectorSearch();
