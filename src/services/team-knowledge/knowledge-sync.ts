// src/services/team-knowledge/knowledge-sync.ts

import { knowledgeStore, getTeamContainerTag } from "./knowledge-store.js";
import { allExtractors } from "./extractors/index.js";
import { getTags } from "../tags.js";
import { log } from "../logger.js";
import type { KnowledgeItem, SyncResult } from "../../types/team-knowledge.js";

let isSyncRunning = false;
let lastSyncTime: number | undefined;

export async function syncTeamKnowledge(directory: string): Promise<SyncResult> {
  if (isSyncRunning) {
    return { added: 0, updated: 0, stale: 0, errors: ["Sync already in progress"] };
  }

  isSyncRunning = true;
  const result: SyncResult = { added: 0, updated: 0, stale: 0, errors: [] };

  try {
    const tags = getTags(directory);
    const containerTag = tags.project.tag;
    const teamTag = getTeamContainerTag(containerTag);

    log("Starting team knowledge sync", { directory, teamTag });

    // 1. Run all extractors
    const currentItems: Map<
      string,
      Omit<KnowledgeItem, "id" | "version" | "stale" | "createdAt" | "updatedAt">
    > = new Map();

    for (const extractor of allExtractors) {
      try {
        const extractResult = await extractor.extract(directory);

        for (const item of extractResult.items) {
          currentItems.set(item.sourceKey, {
            ...item,
            containerTag: teamTag,
          });
        }

        if (extractResult.errors.length > 0) {
          result.errors.push(...extractResult.errors);
        }
      } catch (e) {
        result.errors.push(`Extractor ${extractor.type} failed: ${e}`);
      }
    }

    log("Extraction complete", { itemCount: currentItems.size });

    // 2. Load stored items
    const storedItems = await knowledgeStore.list(containerTag, undefined, 500);
    const storedBySourceKey = new Map<string, KnowledgeItem>();

    for (const item of storedItems) {
      storedBySourceKey.set(item.sourceKey, item);
    }

    // 3. Compute diff
    const toAdd: Array<
      Omit<KnowledgeItem, "id" | "version" | "stale" | "createdAt" | "updatedAt">
    > = [];
    const toUpdate: Array<{
      id: string;
      item: Omit<KnowledgeItem, "id" | "version" | "stale" | "createdAt" | "updatedAt">;
    }> = [];
    const toMarkStale: string[] = [];

    // Find new and changed items
    for (const [sourceKey, item] of currentItems) {
      const existing = storedBySourceKey.get(sourceKey);

      if (!existing) {
        toAdd.push(item);
      } else if (existing.content !== item.content) {
        toUpdate.push({ id: existing.id, item });
      }

      // Remove from stored map (remaining are stale)
      storedBySourceKey.delete(sourceKey);
    }

    // Remaining stored items are stale
    for (const [_, item] of storedBySourceKey) {
      if (!item.stale) {
        toMarkStale.push(item.id);
      }
    }

    log("Diff computed", {
      toAdd: toAdd.length,
      toUpdate: toUpdate.length,
      toMarkStale: toMarkStale.length,
    });

    // 4. Execute updates
    for (const item of toAdd) {
      try {
        await knowledgeStore.insert(item);
        result.added++;
      } catch (e) {
        result.errors.push(`Failed to add item: ${e}`);
      }
    }

    for (const { id, item } of toUpdate) {
      try {
        await knowledgeStore.update(id, item as Partial<KnowledgeItem>);
        result.updated++;
      } catch (e) {
        result.errors.push(`Failed to update item ${id}: ${e}`);
      }
    }

    for (const id of toMarkStale) {
      try {
        await knowledgeStore.markStale(id);
        result.stale++;
      } catch (e) {
        result.errors.push(`Failed to mark stale ${id}: ${e}`);
      }
    }

    // 5. Cleanup old stale items (default 7 days)
    const retentionDays = 7;
    await knowledgeStore.cleanupStale(containerTag, retentionDays);

    lastSyncTime = Date.now();

    log("Team knowledge sync complete", result);
  } catch (e) {
    result.errors.push(`Sync failed: ${e}`);
    log("Team knowledge sync error", { error: String(e) });
  } finally {
    isSyncRunning = false;
  }

  return result;
}

export function getLastSyncTime(): number | undefined {
  return lastSyncTime;
}

export function isSyncing(): boolean {
  return isSyncRunning;
}
