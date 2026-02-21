// src/services/team-knowledge/knowledge-store.ts

import { connectionManager } from "../sqlite/connection-manager.js";
import { shardManager } from "../sqlite/shard-manager.js";
import { vectorSearch } from "../sqlite/vector-search.js";
import { embeddingService } from "../embedding.js";
import { log } from "../logger.js";
import type {
  KnowledgeItem,
  KnowledgeType,
  KnowledgeSearchResult,
} from "../../types/team-knowledge.js";

/**
 * Convert project container tag to team container tag
 * opencode_project_{hash} -> opencode_team_{hash}
 */
function getTeamContainerTag(projectTag: string): string {
  return projectTag.replace("_project_", "_team_");
}

class KnowledgeStore {
  /**
   * Insert a new knowledge item
   */
  async insert(
    item: Omit<KnowledgeItem, "id" | "version" | "stale" | "createdAt" | "updatedAt">
  ): Promise<string> {
    const id = `mem_tk_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();

    const vector = await embeddingService.embedWithTimeout(item.content);
    const tagsVector =
      item.tags.length > 0
        ? await embeddingService.embedWithTimeout(item.tags.join(", "))
        : undefined;

    const { scope, hash } = this.extractScope(item.containerTag);
    const shard = shardManager.getWriteShard(scope, hash);
    const db = connectionManager.getConnection(shard.dbPath);

    const record = {
      id,
      content: item.content,
      vector,
      tagsVector,
      containerTag: item.containerTag,
      tags: item.tags.join(","),
      type: item.type,
      createdAt: now,
      updatedAt: now,
      metadata: JSON.stringify({
        title: item.title,
        sourceKey: item.sourceKey,
        sourceFile: item.sourceFile,
        sourceType: item.sourceType,
        confidence: item.confidence,
        version: 1,
        stale: false,
      }),
    };

    vectorSearch.insertVector(db, record, shard);
    shardManager.incrementVectorCount(shard.id);

    log("Knowledge item inserted", { id, type: item.type, title: item.title });
    return id;
  }

  /**
   * Update an existing knowledge item
   */
  async update(id: string, updates: Partial<KnowledgeItem>): Promise<boolean> {
    const allShards = this.getAllTeamShards();

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const existing = vectorSearch.getMemoryById(db, id);

      if (existing) {
        const now = Date.now();
        const metadata = JSON.parse(existing.metadata || "{}");

        const newContent = updates.content || existing.content;
        const newVector = updates.content
          ? await embeddingService.embedWithTimeout(newContent)
          : undefined;

        const newMetadata = JSON.stringify({
          ...metadata,
          title: updates.title ?? metadata.title,
          sourceKey: updates.sourceKey ?? metadata.sourceKey,
          sourceFile: updates.sourceFile ?? metadata.sourceFile,
          sourceType: updates.sourceType ?? metadata.sourceType,
          confidence: updates.confidence ?? metadata.confidence,
          version: (metadata.version || 1) + 1,
          stale: updates.stale ?? metadata.stale,
        });

        if (newVector) {
          const stmt = db.prepare(`
            UPDATE memories 
            SET content = ?, updated_at = ?, metadata = ?, vector = ?
            WHERE id = ?
          `);
          stmt.run(newContent, now, newMetadata, Buffer.from(newVector.buffer), id);
        } else {
          const stmt = db.prepare(`
            UPDATE memories 
            SET content = ?, updated_at = ?, metadata = ?
            WHERE id = ?
          `);
          stmt.run(newContent, now, newMetadata, id);
        }

        log("Knowledge item updated", { id, version: (metadata.version || 1) + 1 });
        return true;
      }
    }

    return false;
  }

  /**
   * Mark a knowledge item as stale (soft delete)
   */
  async markStale(id: string): Promise<boolean> {
    return this.update(id, { stale: true } as Partial<KnowledgeItem>);
  }

  /**
   * List knowledge items by container tag and optional type filter
   */
  async list(
    containerTag: string,
    type?: KnowledgeType,
    limit: number = 50
  ): Promise<KnowledgeItem[]> {
    const teamTag = getTeamContainerTag(containerTag);
    const { scope, hash } = this.extractScope(teamTag);
    const shards = shardManager.getAllShards(scope, hash);

    const allItems: KnowledgeItem[] = [];

    for (const shard of shards) {
      const db = connectionManager.getConnection(shard.dbPath);

      let query = `SELECT * FROM memories WHERE container_tag = ?`;
      const params: (string | number)[] = [teamTag];

      if (type) {
        query += ` AND type = ?`;
        params.push(type);
      }

      query += ` ORDER BY updated_at DESC LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(query).all(...params) as any[];

      for (const row of rows) {
        const metadata = JSON.parse(row.metadata || "{}");
        if (!metadata.stale) {
          allItems.push(this.rowToKnowledgeItem(row, metadata));
        }
      }
    }

    return allItems.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /**
   * Search knowledge items by query text with vector similarity
   */
  async search(
    query: string,
    containerTag: string,
    options: { threshold?: number; limit?: number; type?: KnowledgeType } = {}
  ): Promise<KnowledgeSearchResult[]> {
    const { threshold = 0.6, limit = 10, type } = options;
    const teamTag = getTeamContainerTag(containerTag);

    const queryVector = await embeddingService.embedWithTimeout(query);
    const { scope, hash } = this.extractScope(teamTag);
    const shards = shardManager.getAllShards(scope, hash);

    if (shards.length === 0) {
      return [];
    }

    const results = await vectorSearch.searchAcrossShards(
      shards,
      queryVector,
      teamTag,
      limit * 2,
      threshold,
      query
    );

    const knowledgeResults: KnowledgeSearchResult[] = [];

    for (const result of results) {
      const metadata = (result.metadata || {}) as Record<string, unknown>;
      if (metadata.stale) continue;

      const itemType = metadata.type as KnowledgeType | undefined;
      if (type && itemType !== type) continue;

      knowledgeResults.push({
        item: {
          id: result.id,
          type: itemType || "tech-stack",
          title: (metadata.title as string) || "",
          content: result.memory || "",
          sourceKey: (metadata.sourceKey as string) || "",
          sourceFile: metadata.sourceFile as string | undefined,
          sourceType: (metadata.sourceType as string) || "code",
          confidence: (metadata.confidence as number) ?? 0.8,
          version: (metadata.version as number) ?? 1,
          stale: false,
          tags: result.tags || [],
          containerTag: teamTag,
          createdAt: (metadata.createdAt as number) || Date.now(),
          updatedAt: (metadata.updatedAt as number) || Date.now(),
        } as KnowledgeItem,
        similarity: result.similarity,
      });
    }

    return knowledgeResults.slice(0, limit);
  }

  /**
   * Get a knowledge item by its source key (for deduplication)
   */
  async getBySourceKey(containerTag: string, sourceKey: string): Promise<KnowledgeItem | null> {
    const teamTag = getTeamContainerTag(containerTag);
    const { scope, hash } = this.extractScope(teamTag);
    const shards = shardManager.getAllShards(scope, hash);

    for (const shard of shards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const row = db
        .prepare(
          `
        SELECT * FROM memories 
        WHERE container_tag = ? AND metadata LIKE ?
        LIMIT 1
      `
        )
        .get(teamTag, `%"sourceKey":"${sourceKey}"%`) as any;

      if (row) {
        const metadata = JSON.parse(row.metadata || "{}");
        return this.rowToKnowledgeItem(row, metadata);
      }
    }

    return null;
  }

  /**
   * Delete a knowledge item permanently
   */
  async delete(id: string): Promise<boolean> {
    const allShards = this.getAllTeamShards();

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const existing = vectorSearch.getMemoryById(db, id);

      if (existing) {
        await vectorSearch.deleteVector(db, id, shard);
        shardManager.decrementVectorCount(shard.id);
        log("Knowledge item deleted", { id });
        return true;
      }
    }

    return false;
  }

  /**
   * Cleanup stale items older than retention period
   */
  async cleanupStale(containerTag: string, retentionDays: number): Promise<number> {
    const teamTag = getTeamContainerTag(containerTag);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const { scope, hash } = this.extractScope(teamTag);
    const shards = shardManager.getAllShards(scope, hash);

    let deleted = 0;

    for (const shard of shards) {
      const db = connectionManager.getConnection(shard.dbPath);

      const rows = db
        .prepare(
          `
        SELECT id FROM memories 
        WHERE container_tag = ? 
        AND metadata LIKE '%"stale":true%'
        AND updated_at < ?
      `
        )
        .all(teamTag, cutoff) as any[];

      for (const row of rows) {
        await vectorSearch.deleteVector(db, row.id, shard);
        shardManager.decrementVectorCount(shard.id);
        deleted++;
      }
    }

    if (deleted > 0) {
      log("Stale knowledge items cleaned up", { deleted, containerTag: teamTag });
    }

    return deleted;
  }

  /**
   * Get statistics for knowledge items in a container
   */
  async getStats(containerTag: string): Promise<{
    total: number;
    byType: Record<KnowledgeType, number>;
    stale: number;
    lastSync?: number;
  }> {
    const teamTag = getTeamContainerTag(containerTag);
    const { scope, hash } = this.extractScope(teamTag);
    const shards = shardManager.getAllShards(scope, hash);

    const stats = {
      total: 0,
      byType: {
        "tech-stack": 0,
        architecture: 0,
        "coding-standard": 0,
        lesson: 0,
        "business-logic": 0,
      } as Record<KnowledgeType, number>,
      stale: 0,
      lastSync: undefined as number | undefined,
    };

    for (const shard of shards) {
      const db = connectionManager.getConnection(shard.dbPath);

      const rows = db
        .prepare(
          `
        SELECT type, metadata, updated_at FROM memories 
        WHERE container_tag = ?
      `
        )
        .all(teamTag) as any[];

      for (const row of rows) {
        const metadata = JSON.parse(row.metadata || "{}");

        if (metadata.stale) {
          stats.stale++;
        } else {
          stats.total++;
          if (row.type && stats.byType[row.type as KnowledgeType] !== undefined) {
            stats.byType[row.type as KnowledgeType]++;
          }
        }

        if (!stats.lastSync || row.updated_at > stats.lastSync) {
          stats.lastSync = row.updated_at;
        }
      }
    }

    return stats;
  }

  /**
   * Extract scope and hash from container tag
   * opencode_team_{hash} -> { scope: 'project', hash }
   */
  private extractScope(containerTag: string): { scope: "user" | "project"; hash: string } {
    const parts = containerTag.split("_");
    if (parts.length >= 3) {
      const scopeType = parts[1] as "user" | "project" | "team";
      const hash = parts.slice(2).join("_");
      // Team knowledge uses project scope for storage
      const scope: "user" | "project" = scopeType === "user" ? "user" : "project";
      return { scope, hash };
    }
    return { scope: "project", hash: containerTag };
  }

  /**
   * Get all shards that might contain team knowledge
   */
  private getAllTeamShards() {
    // Get all project-scoped shards (team knowledge shares project storage)
    return shardManager.getAllShards("project", "");
  }

  /**
   * Convert database row to KnowledgeItem
   */
  private rowToKnowledgeItem(row: any, metadata: any): KnowledgeItem {
    return {
      id: row.id,
      type: row.type as KnowledgeType,
      title: metadata.title || "",
      content: row.content,
      sourceKey: metadata.sourceKey || "",
      sourceFile: metadata.sourceFile,
      sourceType: metadata.sourceType || "code",
      confidence: metadata.confidence || 0.8,
      version: metadata.version || 1,
      stale: metadata.stale || false,
      tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
      containerTag: row.container_tag,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const knowledgeStore = new KnowledgeStore();
export { getTeamContainerTag };
