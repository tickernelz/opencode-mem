import { tursoConnectionManager } from "./connection-manager.js";
import { tursoShardManager } from "./shard-manager.js";
import { isIdxDeleteMismatchError } from "./error-classifiers.js";
import { log } from "../logger.js";
import type { MemoryListFilters, MemoryRecord, SearchResult, ShardInfo } from "./types.js";
import {
  distanceToSimilarity,
  escapeLikePattern,
  parseSessionIdFromMetadata,
  tokenizeQueryText,
  vectorToJson,
} from "./vector-utils.js";
import type { TursoDb, TursoTx } from "./turso-db.js";

/** Active (non-trashed) rows. Legacy DBs without deleted_at treat NULL as active. */
export const ACTIVE_MEMORY_SQL = `(deleted_at IS NULL)`;
export const ACTIVE_MEMORY_ALIAS_SQL = `(m.deleted_at IS NULL)`;

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resolveSessionId(record: MemoryRecord): string | null {
  if (record.sessionId && record.sessionId.length > 0) return record.sessionId;
  return parseSessionIdFromMetadata(record.metadata);
}

function insertArgs(record: MemoryRecord, contentVector: string, tagsVectorJson: string | null) {
  return [
    record.id,
    record.content,
    contentVector,
    ...(tagsVectorJson ? [tagsVectorJson] : []),
    record.containerTag,
    record.tags || null,
    record.type || null,
    record.createdAt,
    record.updatedAt,
    record.metadata || null,
    resolveSessionId(record),
    record.displayName || null,
    record.userName || null,
    record.userEmail || null,
    record.projectPath || null,
    record.projectName || null,
    record.gitRepoUrl || null,
  ];
}

const INSERT_WITH_TAGS = `
  INSERT INTO memories (
    id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
    metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
  ) VALUES (?, ?, vector32(?), vector32(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_WITHOUT_TAGS = `
  INSERT INTO memories (
    id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
    metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url
  ) VALUES (?, ?, vector32(?), NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class TursoVectorSearch {
  private async prepareShardDb(db: TursoDb): Promise<void> {
    await tursoShardManager.ensureShardSchema(db);
  }

  async insertVectorInTransaction(tx: TursoTx, record: MemoryRecord): Promise<void> {
    const contentVector = vectorToJson(record.vector);
    if (record.tagsVector) {
      await tx.execute({
        sql: INSERT_WITH_TAGS,
        args: insertArgs(record, contentVector, vectorToJson(record.tagsVector)),
      });
      return;
    }

    await tx.execute({
      sql: INSERT_WITHOUT_TAGS,
      args: insertArgs(record, contentVector, null),
    });
  }

  async insertVector(db: TursoDb, record: MemoryRecord): Promise<void> {
    await this.prepareShardDb(db);
    const contentVector = vectorToJson(record.vector);
    if (record.tagsVector) {
      await db.execute(
        INSERT_WITH_TAGS,
        insertArgs(record, contentVector, vectorToJson(record.tagsVector))
      );
      return;
    }

    await db.execute(INSERT_WITHOUT_TAGS, insertArgs(record, contentVector, null));
  }

  async searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    await this.prepareShardDb(db);
    const queryJson = vectorToJson(queryVector);
    // Exact cosine already returns the best-k rows; over-fetch a little so
    // content+tags+keyword candidates can merge before hybrid re-rank.
    const k = Math.max(limit * 2, 32);

    const contentResults = await this.exactScanKind(db, queryJson, k, containerTag, "vector");
    const tagsResults = await this.exactScanKind(db, queryJson, k, containerTag, "tags_vector");
    const keywordScores = await this.keywordScores(db, queryText, containerTag, k);

    const candidateIds = new Set<string>();
    for (const result of contentResults) candidateIds.add(result.id);
    for (const result of tagsResults) candidateIds.add(result.id);
    for (const id of keywordScores.keys()) candidateIds.add(id);

    const ids = Array.from(candidateIds);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.all(
      containerTag === ""
        ? `
      SELECT id, content, tags, created_at, metadata, container_tag,
             display_name, user_name, user_email, project_path, project_name,
             git_repo_url, is_pinned, session_id,
             vector_distance_cos(vector, vector32(?)) AS content_dist,
             CASE WHEN tags_vector IS NOT NULL
               THEN vector_distance_cos(tags_vector, vector32(?))
               ELSE NULL END AS tags_dist
      FROM memories
      WHERE id IN (${placeholders}) AND ${ACTIVE_MEMORY_SQL}
    `
        : `
      SELECT id, content, tags, created_at, metadata, container_tag,
             display_name, user_name, user_email, project_path, project_name,
             git_repo_url, is_pinned, session_id,
             vector_distance_cos(vector, vector32(?)) AS content_dist,
             CASE WHEN tags_vector IS NOT NULL
               THEN vector_distance_cos(tags_vector, vector32(?))
               ELSE NULL END AS tags_dist
      FROM memories
      WHERE id IN (${placeholders}) AND container_tag = ? AND ${ACTIVE_MEMORY_SQL}
    `,
      containerTag === ""
        ? [queryJson, queryJson, ...ids]
        : [queryJson, queryJson, ...ids, containerTag]
    );

    const queryWords = tokenizeQueryText(queryText);
    const hasKeyword = queryWords.length > 0;

    const hydratedResults = rows.map((row: Record<string, unknown>) => {
      const contentSim = distanceToSimilarity(Number(row.content_dist));
      const tagsSim =
        row.tags_dist == null || row.tags_dist === undefined
          ? 0
          : distanceToSimilarity(Number(row.tags_dist));
      const memoryTagsStr = String(row.tags || "");
      // filter(Boolean): "".split(",") → [""], and "query".includes("") is always true.
      const memoryTags = memoryTagsStr
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);

      let exactMatchBoost = 0;
      if (queryWords.length > 0 && memoryTags.length > 0) {
        const matches = queryWords.filter((word) =>
          memoryTags.some((tag) => tag.includes(word) || word.includes(tag))
        ).length;
        exactMatchBoost = matches / Math.max(queryWords.length, 1);
      }

      const keywordSim = keywordScores.get(String(row.id)) ?? 0;
      const finalTagsSim = Math.max(tagsSim, exactMatchBoost);
      // With query text: blend vector + keyword. Without: keep classic 0.6/0.4.
      const similarity = hasKeyword
        ? contentSim * 0.5 + finalTagsSim * 0.3 + keywordSim * 0.2
        : contentSim * 0.6 + finalTagsSim * 0.4;

      return {
        id: String(row.id),
        memory: String(row.content),
        similarity,
        createdAt: Number(row.created_at),
        tags: memoryTagsStr ? memoryTagsStr.split(",") : [],
        metadata: parseMetadata(row.metadata),
        containerTag: String(row.container_tag),
        sessionId: row.session_id ? String(row.session_id) : undefined,
        displayName: row.display_name ? String(row.display_name) : undefined,
        userName: row.user_name ? String(row.user_name) : undefined,
        userEmail: row.user_email ? String(row.user_email) : undefined,
        projectPath: row.project_path ? String(row.project_path) : undefined,
        projectName: row.project_name ? String(row.project_name) : undefined,
        gitRepoUrl: row.git_repo_url ? String(row.git_repo_url) : undefined,
        isPinned: row.is_pinned,
      };
    });

    hydratedResults.sort((a, b) => b.similarity - a.similarity);
    return hydratedResults.slice(0, Math.max(0, limit));
  }

  /**
   * Keyword recall for hybrid ranking.
   * `@tursodatabase/database` does not ship FTS5, so we use tokenized LIKE
   * over content/tags (bounded tokens, ESCAPE-safe).
   */
  private async keywordScores(
    db: TursoDb,
    queryText: string | undefined,
    containerTag: string,
    limit: number
  ): Promise<Map<string, number>> {
    const tokens = tokenizeQueryText(queryText);
    if (tokens.length === 0) return new Map();

    const scores = new Map<string, number>();
    for (const token of tokens) {
      const pattern = `%${escapeLikePattern(token)}%`;
      const rows = await db.all(
        containerTag === ""
          ? `
          SELECT id FROM memories
          WHERE ${ACTIVE_MEMORY_SQL}
            AND (content LIKE ? ESCAPE '\\' OR IFNULL(tags, '') LIKE ? ESCAPE '\\')
          LIMIT ?
        `
          : `
          SELECT id FROM memories
          WHERE container_tag = ?
            AND ${ACTIVE_MEMORY_SQL}
            AND (content LIKE ? ESCAPE '\\' OR IFNULL(tags, '') LIKE ? ESCAPE '\\')
          LIMIT ?
        `,
        containerTag === "" ? [pattern, pattern, limit] : [containerTag, pattern, pattern, limit]
      );
      for (const row of rows) {
        const id = String(row.id);
        scores.set(id, (scores.get(id) ?? 0) + 1 / tokens.length);
      }
    }
    return scores;
  }

  private async exactScanKind(
    db: TursoDb,
    queryJson: string,
    k: number,
    containerTag: string,
    columnName: string
  ): Promise<Array<{ id: string; similarity: number }>> {
    const rows = await db.all(
      containerTag === ""
        ? `
        SELECT m.id AS id, vector_distance_cos(m.${columnName}, vector32(?)) AS dist
        FROM memories m
        WHERE m.${columnName} IS NOT NULL AND ${ACTIVE_MEMORY_ALIAS_SQL}
        ORDER BY dist ASC
        LIMIT ?
      `
        : `
        SELECT m.id AS id, vector_distance_cos(m.${columnName}, vector32(?)) AS dist
        FROM memories m
        WHERE m.${columnName} IS NOT NULL AND m.container_tag = ?
          AND ${ACTIVE_MEMORY_ALIAS_SQL}
        ORDER BY dist ASC
        LIMIT ?
      `,
      containerTag === "" ? [queryJson, k] : [queryJson, containerTag, k]
    );

    return rows.map((row) => ({
      id: String(row.id),
      similarity: distanceToSimilarity(Number(row.dist)),
    }));
  }

  async searchAcrossShards(
    shards: ShardInfo[],
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string
  ): Promise<{ results: SearchResult[]; warnings: string[] }> {
    const shardErrors: Array<{ shardId: number; error: string }> = [];

    const shardPromises = shards.map(async (shard) => {
      try {
        return await this.searchInShard(shard, queryVector, containerTag, limit, queryText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("Shard search error", { shardId: shard.id, error: message });
        shardErrors.push({ shardId: shard.id, error: message });
        return [];
      }
    });

    const resultsArray = await Promise.all(shardPromises);

    if (shardErrors.length > 0 && shardErrors.length === shards.length) {
      throw new Error(
        `Vector search failed on all shards: ${shardErrors.map((entry) => `${entry.shardId}: ${entry.error}`).join("; ")}`
      );
    }

    const warnings =
      shardErrors.length > 0
        ? [
            `Vector search completed with partial shard failures (${shardErrors.length}/${shards.length}): ${shardErrors
              .map((entry) => `${entry.shardId}: ${entry.error}`)
              .join("; ")}`,
          ]
        : [];

    if (warnings.length > 0) {
      log("Vector search completed with partial shard failures", {
        failedShards: shardErrors,
        totalShards: shards.length,
      });
    }

    const allResults = resultsArray.flat();
    allResults.sort((a, b) => b.similarity - a.similarity);
    return {
      results: allResults
        .filter((result) => result.similarity >= similarityThreshold)
        .slice(0, limit),
      warnings,
    };
  }

  async deleteVector(db: TursoDb, memoryId: string): Promise<void> {
    try {
      await db.run(`DELETE FROM memories WHERE id = ?`, [memoryId]);
    } catch (error) {
      if (!isIdxDeleteMismatchError(error)) throw error;
      // Only treat as success when the row is actually gone. IdxDelete with the
      // row still present means the DELETE rolled back — callers must not count
      // a delete or decrement vector counts.
      const remaining = await db.get(`SELECT id, deleted_at FROM memories WHERE id = ?`, [
        memoryId,
      ]);
      if (!remaining) return;

      // Quarantine active rows so age-based cleanup stops re-hitting the same
      // broken index key every run. Soft-deleted orphans stay for trash purge.
      if (remaining.deleted_at == null) {
        const now = Date.now();
        try {
          await db.run(
            `UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
            [now, now, memoryId]
          );
          log("deleteVector: IdxDelete quarantined active row via soft-delete", {
            memoryId,
            error: String(error),
          });
        } catch (quarantineError) {
          log("deleteVector: IdxDelete quarantine failed", {
            memoryId,
            error: String(quarantineError),
          });
        }
      } else {
        log("deleteVector: IdxDelete with soft-deleted row still present", {
          memoryId,
          error: String(error),
        });
      }
      throw error;
    }
  }

  async softDeleteVector(
    db: TursoDb,
    memoryId: string,
    metaPatch?: Record<string, unknown>
  ): Promise<boolean> {
    await this.prepareShardDb(db);
    const existing = await this.getMemoryById(db, memoryId, { includeDeleted: false });
    if (!existing) return false;
    const meta = parseMetadata(existing.metadata) || {};
    if (metaPatch) Object.assign(meta, metaPatch);
    const changes = await db.run(
      `UPDATE memories SET deleted_at = ?, metadata = ?, updated_at = ? WHERE id = ? AND ${ACTIVE_MEMORY_SQL}`,
      [Date.now(), JSON.stringify(meta), Date.now(), memoryId]
    );
    return changes > 0;
  }

  async patchMemoryMetadata(
    db: TursoDb,
    memoryId: string,
    metaPatch: Record<string, unknown>
  ): Promise<boolean> {
    await this.prepareShardDb(db);
    const existing = await this.getMemoryById(db, memoryId, { includeDeleted: false });
    if (!existing) return false;
    const meta = parseMetadata(existing.metadata) || {};
    Object.assign(meta, metaPatch);
    const changes = await db.run(
      `UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ? AND ${ACTIVE_MEMORY_SQL}`,
      [JSON.stringify(meta), Date.now(), memoryId]
    );
    return changes > 0;
  }

  async restoreVector(db: TursoDb, memoryId: string): Promise<boolean> {
    await this.prepareShardDb(db);
    const changes = await db.run(
      `UPDATE memories SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`,
      [Date.now(), memoryId]
    );
    return changes > 0;
  }

  async listDeletedMemories(db: TursoDb, limit = 200): Promise<Record<string, unknown>[]> {
    await this.prepareShardDb(db);
    return db.all(
      `
      SELECT * FROM memories
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
      LIMIT ?
    `,
      [limit]
    );
  }

  async purgeDeletedBefore(db: TursoDb, cutoffMs: number): Promise<string[]> {
    await this.prepareShardDb(db);
    const rows = await db.all(
      `SELECT id FROM memories WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
      [cutoffMs]
    );
    const purged: string[] = [];
    for (const row of rows) {
      const id = String(row.id);
      try {
        await this.deleteVector(db, id);
        purged.push(id);
      } catch (error) {
        log("purgeDeletedBefore: delete error", { memoryId: id, error: String(error) });
      }
    }
    return purged;
  }

  async updateVector(
    db: TursoDb,
    memoryId: string,
    vector: Float32Array,
    tagsVector?: Float32Array
  ): Promise<void> {
    const contentVector = vectorToJson(vector);
    if (tagsVector) {
      await db.execute(
        `UPDATE memories SET vector = vector32(?), tags_vector = vector32(?) WHERE id = ?`,
        [contentVector, vectorToJson(tagsVector), memoryId]
      );
    } else {
      await db.execute(
        `UPDATE memories SET vector = vector32(?), tags_vector = NULL WHERE id = ?`,
        [contentVector, memoryId]
      );
    }
  }

  async listMemories(
    db: TursoDb,
    containerTag: string,
    limit: number,
    filters: MemoryListFilters = {}
  ): Promise<Record<string, unknown>[]> {
    await this.prepareShardDb(db);
    const conditions: string[] = [ACTIVE_MEMORY_SQL];
    const args: Array<string | number> = [];
    if (containerTag !== "") {
      conditions.push("container_tag = ?");
      args.push(containerTag);
    }
    if (filters.excludeSessionId !== undefined) {
      // Prefer the indexed session_id column (same resolution as insert/get-by-session),
      // then fall back to metadata.sessionID for legacy rows. Absent/malformed metadata
      // with a null session_id stays eligible — matching prior JS undefined semantics.
      conditions.push(
        `COALESCE(
          NULLIF(session_id, ''),
          CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sessionID') END
        ) IS NOT ?`
      );
      args.push(filters.excludeSessionId);
    }
    if (filters.createdAfter !== undefined) {
      conditions.push("created_at > ?");
      args.push(filters.createdAfter);
    }
    args.push(limit);
    return db.all(
      `
      SELECT * FROM memories
      WHERE ${conditions.join(" AND ")}
      ORDER BY is_pinned DESC, created_at DESC
      LIMIT ?
    `,
      args
    );
  }

  async getAllMemories(db: TursoDb): Promise<Record<string, unknown>[]> {
    await this.prepareShardDb(db);
    return db.all(`SELECT * FROM memories WHERE ${ACTIVE_MEMORY_SQL} ORDER BY created_at DESC`);
  }

  async getAllMemoriesWithExtractedVectors(
    db: TursoDb
  ): Promise<Array<Record<string, unknown> & { vector_json: string | null }>> {
    await this.prepareShardDb(db);
    return db.all(`
      SELECT
        id,
        content,
        container_tag,
        created_at,
        is_pinned,
        vector_extract(vector) AS vector_json
      FROM memories
      WHERE ${ACTIVE_MEMORY_SQL}
      ORDER BY created_at DESC
    `);
  }

  async getMemoryById(
    db: TursoDb,
    memoryId: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<Record<string, unknown> | null> {
    await this.prepareShardDb(db);
    if (options.includeDeleted) {
      return db.get(`SELECT * FROM memories WHERE id = ?`, [memoryId]);
    }
    return db.get(`SELECT * FROM memories WHERE id = ? AND ${ACTIVE_MEMORY_SQL}`, [memoryId]);
  }

  async getMemoriesBySessionID(db: TursoDb, sessionID: string): Promise<Record<string, unknown>[]> {
    await this.prepareShardDb(db);
    const rows = await db.all(
      `
      SELECT * FROM memories
      WHERE ${ACTIVE_MEMORY_SQL}
        AND (
          session_id = ?
          OR (session_id IS NULL AND metadata LIKE ?)
        )
      ORDER BY created_at DESC
    `,
      [sessionID, `%"sessionID":"${sessionID}"%`]
    );

    return rows.map((row) => ({
      ...row,
      tags: row.tags ? String(row.tags).split(",") : [],
      metadata: row.metadata ? (parseMetadata(String(row.metadata)) ?? {}) : {},
    }));
  }

  async countVectors(db: TursoDb, containerTag: string): Promise<number> {
    const row = await db.get(
      `SELECT COUNT(*) as count FROM memories WHERE container_tag = ? AND ${ACTIVE_MEMORY_SQL}`,
      [containerTag]
    );
    return Number(row?.count ?? 0);
  }

  async countAllVectors(db: TursoDb): Promise<number> {
    const row = await db.get(`SELECT COUNT(*) as count FROM memories WHERE ${ACTIVE_MEMORY_SQL}`);
    return Number(row?.count ?? 0);
  }

  async getDistinctTags(db: TursoDb): Promise<Record<string, unknown>[]> {
    return db.all(`
      SELECT DISTINCT
        container_tag,
        display_name,
        user_name,
        user_email,
        project_path,
        project_name,
        git_repo_url
      FROM memories
      WHERE ${ACTIVE_MEMORY_SQL}
    `);
  }

  async getProjectPathCounts(
    db: TursoDb
  ): Promise<Array<{ projectPath: string; count: number; containerTag: string | null }>> {
    const rows = await db.all(`
      SELECT
        project_path AS project_path,
        container_tag AS container_tag,
        COUNT(*) AS cnt
      FROM memories
      WHERE project_path IS NOT NULL AND project_path != ''
        AND ${ACTIVE_MEMORY_SQL}
      GROUP BY project_path, container_tag
      ORDER BY cnt DESC, project_path ASC
    `);
    return rows.map((row) => ({
      projectPath: String(row.project_path),
      count: Number(row.cnt ?? 0),
      containerTag: row.container_tag ? String(row.container_tag) : null,
    }));
  }

  async updateProjectAssociation(
    db: TursoDb,
    oldContainerTag: string,
    update: {
      containerTag: string;
      projectPath?: string;
      projectName?: string;
      displayName?: string;
      gitRepoUrl?: string | null;
    }
  ): Promise<number> {
    return db.run(
      `
      UPDATE memories SET
        container_tag = ?,
        project_path = ?,
        project_name = ?,
        display_name = ?,
        git_repo_url = ?
      WHERE container_tag = ?
    `,
      [
        update.containerTag,
        update.projectPath ?? null,
        update.projectName ?? null,
        update.displayName ?? null,
        update.gitRepoUrl ?? null,
        oldContainerTag,
      ]
    );
  }

  async pinMemory(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`UPDATE memories SET is_pinned = 1 WHERE id = ?`, [memoryId]);
  }

  async unpinMemory(db: TursoDb, memoryId: string): Promise<void> {
    await db.run(`UPDATE memories SET is_pinned = 0 WHERE id = ?`, [memoryId]);
  }
}

export const tursoVectorSearch = new TursoVectorSearch();
