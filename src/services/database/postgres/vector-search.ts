import pgvector from "pgvector/pg";
import { connectionManager } from "./connection-manager.js";
import { log } from "../../logger.js";
import type { MemoryRecord, SearchResult, SearchResultRow, MemoryRow, DistinctTagRow } from "./types.js";

export class VectorSearch {
  async insertMemory(record: MemoryRecord): Promise<void> {
    const pool = await connectionManager.getPool();

    const query = `
      INSERT INTO memories (
        id, content, embedding, tags_embedding, container_tag, tags, type,
        created_at, updated_at, metadata, display_name, user_name, user_email,
        project_path, project_name, git_repo_url, is_pinned
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0),
        $10, $11, $12, $13, $14, $15, $16, $17
      )
    `;

    const values = [
      record.id,
      record.content,
      pgvector.toSql(record.embedding),
      record.tagsEmbedding ? pgvector.toSql(record.tagsEmbedding) : null,
      record.containerTag,
      record.tags || null,
      record.type || null,
      record.createdAt,
      record.updatedAt,
      record.metadata ? JSON.parse(record.metadata) : null,
      record.displayName || null,
      record.userName || null,
      record.userEmail || null,
      record.projectPath || null,
      record.projectName || null,
      record.gitRepoUrl || null,
      record.isPinned || false,
    ];

    await pool.query(query, values);
  }

  async searchMemories(
    queryVector: number[],
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    const pool = await connectionManager.getPool();

    const contentQuery = `
      SELECT
        id, content, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path,
        project_name, git_repo_url, is_pinned,
        1 - (embedding <=> $1) as content_similarity,
        CASE WHEN tags_embedding IS NOT NULL
          THEN 1 - (tags_embedding <=> $1)
          ELSE 0
        END as tags_similarity
      FROM memories
      WHERE container_tag = $2
      ORDER BY embedding <=> $1
      LIMIT $3
    `;

    const result = await pool.query(contentQuery, [
      pgvector.toSql(queryVector),
      containerTag,
      limit * 4,
    ]);

    const queryWords = queryText
      ? queryText
          .toLowerCase()
          .split(/[\s,]+/)
          .filter((w) => w.length > 1)
      : [];

    const processedResults = result.rows.map((row: any) => {
      const memoryTagsStr = row.tags || "";
      const memoryTags = memoryTagsStr.split(",").map((t: string) => t.trim().toLowerCase());

      let exactMatchBoost = 0;
      if (queryWords.length > 0 && memoryTags.length > 0 && memoryTags[0] !== "") {
        const matches = queryWords.filter((w) =>
          memoryTags.some((t: string) => t.includes(w) || w.includes(t))
        ).length;
        exactMatchBoost = matches / Math.max(queryWords.length, 1);
      }

      const tagSim = Math.max(row.tags_similarity || 0, exactMatchBoost);
      const similarity = tagSim * 0.8 + row.content_similarity * 0.2;

      return {
        id: row.id,
        memory: row.content,
        similarity,
        tags: memoryTagsStr ? memoryTagsStr.split(",") : [],
        metadata: row.metadata || undefined,
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

    return processedResults
      .filter((r) => r.similarity >= similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    const pool = await connectionManager.getPool();
    const result = await pool.query("DELETE FROM memories WHERE id = $1", [memoryId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listMemories(containerTag: string, limit: number): Promise<MemoryRow[]> {
    const pool = await connectionManager.getPool();
    const query = `
      SELECT
        id, content, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path,
        project_name, git_repo_url, is_pinned
      FROM memories
      WHERE container_tag = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await pool.query(query, [containerTag, limit]);
    return result.rows;
  }

  async getAllMemories(): Promise<MemoryRow[]> {
    const pool = await connectionManager.getPool();
    const query = `
      SELECT
        id, content, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path,
        project_name, git_repo_url, is_pinned
      FROM memories
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  async getMemoryById(memoryId: string): Promise<MemoryRow | null> {
    const pool = await connectionManager.getPool();
    const query = `
      SELECT
        id, content, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path,
        project_name, git_repo_url, is_pinned
      FROM memories
      WHERE id = $1
    `;
    const result = await pool.query(query, [memoryId]);
    return result.rows[0] || null;
  }

  async countMemories(containerTag: string): Promise<number> {
    const pool = await connectionManager.getPool();
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM memories WHERE container_tag = $1",
      [containerTag]
    );
    return parseInt(result.rows[0].count, 10);
  }

  async countAllMemories(): Promise<number> {
    const pool = await connectionManager.getPool();
    const result = await pool.query("SELECT COUNT(*) as count FROM memories");
    return parseInt(result.rows[0].count, 10);
  }

  async getDistinctTags(): Promise<DistinctTagRow[]> {
    const pool = await connectionManager.getPool();
    const query = `
      SELECT DISTINCT
        container_tag,
        display_name,
        user_name,
        user_email,
        project_path,
        project_name,
        git_repo_url
      FROM memories
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  async pinMemory(memoryId: string): Promise<void> {
    const pool = await connectionManager.getPool();
    await pool.query("UPDATE memories SET is_pinned = TRUE WHERE id = $1", [memoryId]);
  }

  async unpinMemory(memoryId: string): Promise<void> {
    const pool = await connectionManager.getPool();
    await pool.query("UPDATE memories SET is_pinned = FALSE WHERE id = $1", [memoryId]);
  }

  async updateMemory(memoryId: string, content: string, embedding: number[]): Promise<void> {
    const pool = await connectionManager.getPool();
    const query = `
      UPDATE memories
      SET content = $1, embedding = $2, updated_at = NOW()
      WHERE id = $3
    `;
    await pool.query(query, [content, pgvector.toSql(embedding), memoryId]);
  }
}

export const vectorSearch = new VectorSearch();
