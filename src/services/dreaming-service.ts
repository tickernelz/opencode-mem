import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { embeddingService } from "./embedding.js";
import { log } from "./logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { ensureTursoReady } from "./turso/ready.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { parseExtractedVector, formatTagsForEmbedding } from "./turso/vector-utils.js";
import { getV2Client } from "./ai/opencode-provider.js";
import { tryAcquireDreamingLock } from "./dreaming-lock.js";

export const DREAMING_MAX_GROUP_SIZE = 5;

export interface DreamingNearDupGroup {
  representative: {
    id: string;
    content: string;
    containerTag: string;
    createdAt: number;
    isPinned: boolean;
    scope: "user" | "project";
  };
  duplicates: Array<{
    id: string;
    content: string;
    similarity: number;
    isPinned: boolean;
    containerTag: string;
    createdAt: number;
  }>;
}

export type DreamingMemoryEntry = {
  id: string;
  content: string;
  containerTag: string;
  createdAt: number;
  vector: Float32Array;
};

/**
 * Pure grouping used by dreaming (and unit tests). Pinned rows must be
 * excluded by the caller before invoking this.
 */
export function groupRelatedMemoryEntries(
  entries: DreamingMemoryEntry[],
  options: {
    threshold: number;
    allowCrossTag: boolean;
    scope: "user" | "project";
    maxGroupSize?: number;
  }
): DreamingNearDupGroup[] {
  const threshold = options.threshold;
  const allowCrossTag = options.allowCrossTag;
  const maxGroupSize = options.maxGroupSize ?? DREAMING_MAX_GROUP_SIZE;
  const groups: DreamingNearDupGroup[] = [];
  const processedIds = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const mem1 = entries[i]!;
    if (processedIds.has(mem1.id)) continue;

    const similarGroup: DreamingNearDupGroup = {
      representative: {
        id: mem1.id,
        content: mem1.content,
        containerTag: mem1.containerTag,
        createdAt: mem1.createdAt,
        isPinned: false,
        scope: options.scope,
      },
      duplicates: [],
    };

    for (let j = i + 1; j < entries.length; j++) {
      const mem2 = entries[j]!;
      if (processedIds.has(mem2.id)) continue;
      if (!allowCrossTag && mem1.containerTag !== mem2.containerTag) continue;

      const similarity = cosineSimilarity(mem1.vector, mem2.vector);
      if (similarity >= threshold && similarity < 1.0) {
        similarGroup.duplicates.push({
          id: mem2.id,
          content: mem2.content,
          similarity,
          isPinned: false,
          containerTag: mem2.containerTag,
          createdAt: mem2.createdAt,
        });
        processedIds.add(mem2.id);
        if (similarGroup.duplicates.length >= maxGroupSize - 1) break;
      }
    }

    if (similarGroup.duplicates.length > 0) {
      processedIds.add(mem1.id);
      groups.push(similarGroup);
    }
  }

  return groups;
}

export interface DreamingRunResult {
  groupsConsidered: number;
  groupsMerged: number;
  groupsSkipped: number;
  groupsFailed: number;
  groupsFlagged: number;
  memoriesSoftDeleted: number;
}

interface DreamingState {
  lastRunAt: number;
}

const dreamingActionSchema = z.object({
  action: z.enum(["merge", "update", "supersede", "keep", "flag"]),
  content: z.string().optional(),
  keepId: z.string().optional(),
  dropIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

function statePath(): string {
  return join(CONFIG.storagePath, "dreaming-state.json");
}

function readState(): DreamingState {
  try {
    const path = statePath();
    if (!existsSync(path)) return { lastRunAt: 0 };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as DreamingState;
    return { lastRunAt: Number(raw.lastRunAt) || 0 };
  } catch {
    return { lastRunAt: 0 };
  }
}

function writeState(state: DreamingState): void {
  const dir = CONFIG.storagePath;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state), "utf-8");
}

export function isDreamingCrossProjectEnabled(): boolean {
  return Boolean(CONFIG.dreaming.crossProject) || CONFIG.memory.defaultScope === "all-projects";
}

type MemoryRow = {
  id: unknown;
  content: unknown;
  container_tag: unknown;
  created_at: unknown;
  is_pinned?: unknown;
  vector_json?: unknown;
};

/**
 * Group related memories for dreaming. Uses dreaming.relatedThreshold
 * (not deduplicationSimilarityThreshold). Cross-project grouping is opt-in /
 * follows memory.defaultScope; user-scope never mixes with project-scope.
 */
export async function findNearDuplicateGroupsForDreaming(): Promise<DreamingNearDupGroup[]> {
  await ensureTursoReady();
  const userShards = await tursoShardManager.getAllShards("user", "");
  const projectShards = await tursoShardManager.getAllShards("project", "");
  const threshold = CONFIG.dreaming.relatedThreshold;
  const crossProject = isDreamingCrossProjectEnabled();
  const groups: DreamingNearDupGroup[] = [];

  const collectFromShardPool = async (
    shards: Awaited<ReturnType<typeof tursoShardManager.getAllShards>>,
    scope: "user" | "project",
    allowCrossTag: boolean
  ) => {
    const entries: DreamingMemoryEntry[] = [];

    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memories = await tursoVectorSearch.getAllMemoriesWithExtractedVectors(db);
      for (const mem of memories as MemoryRow[]) {
        if (Number(mem.is_pinned ?? 0) === 1) continue;
        const vector = parseExtractedVector(mem.vector_json);
        if (!vector) continue;
        entries.push({
          id: String(mem.id),
          content: String(mem.content),
          containerTag: String(mem.container_tag),
          createdAt: Number(mem.created_at),
          vector,
        });
      }
    }

    groups.push(
      ...groupRelatedMemoryEntries(entries, {
        threshold,
        allowCrossTag,
        scope,
        maxGroupSize: DREAMING_MAX_GROUP_SIZE,
      })
    );
  };

  // User-scope: always same container_tag only (never mix with projects).
  await collectFromShardPool(userShards, "user", false);
  // Project-scope: cross-tag when crossProject / defaultScope all-projects.
  await collectFromShardPool(projectShards, "project", crossProject);

  return groups;
}

export function buildMergePrompt(group: DreamingNearDupGroup): string {
  const items = [
    {
      id: group.representative.id,
      content: group.representative.content,
      createdAt: group.representative.createdAt,
      containerTag: group.representative.containerTag,
    },
    ...group.duplicates.map((d) => ({
      id: d.id,
      content: d.content,
      createdAt: d.createdAt,
      containerTag: d.containerTag,
      similarity: Number(d.similarity.toFixed(3)),
    })),
  ];
  return `You consolidate related project/user memories. They may be near-duplicates OR newer facts that replace older ones.

Rules:
- "merge": same fact worded differently → one clearer entry (keepId + dropIds + content).
- "update": rewrite keepId with the current correct content; soft-delete dropIds.
- "supersede": newer fact replaces older → keep newest correct content on keepId (or prefer newest id), soft-delete outdated dropIds.
- "keep": related but all still valid / unsafe to change — no mutation.
- "flag": clear contradiction you cannot resolve — no mutation; we mark metadata.
- Prefer the newest correct fact when one clearly supersedes another.
- Merged/updated content MUST retain important details, including why something failed when present.
- Do NOT invent facts. Do NOT drop unique constraints, commands, paths, or error messages.
- keepId must be one of the input ids. dropIds lists every other id when merging/updating/superseding.
- Use "keep" when memories are only loosely related.

Return JSON matching the schema.

Memories:
${JSON.stringify(items, null, 2)}`;
}

export class DreamingService {
  private isRunning = false;

  getStatus() {
    const state = readState();
    return {
      enabled: CONFIG.dreaming.enabled,
      intervalHours: CONFIG.dreaming.intervalHours,
      maxGroupsPerRun: CONFIG.dreaming.maxGroupsPerRun,
      trashRetentionDays: CONFIG.dreaming.trashRetentionDays,
      relatedThreshold: CONFIG.dreaming.relatedThreshold,
      crossProject: CONFIG.dreaming.crossProject,
      crossProjectEffective: isDreamingCrossProjectEnabled(),
      isRunning: this.isRunning,
      lastRunAt: state.lastRunAt || null,
    };
  }

  async shouldRun(): Promise<boolean> {
    if (!CONFIG.dreaming.enabled) return false;
    if (this.isRunning) return false;
    if (!CONFIG.autoCaptureProviderStatus?.ready) return false;
    const state = readState();
    const intervalMs = CONFIG.dreaming.intervalHours * 60 * 60 * 1000;
    return Date.now() - state.lastRunAt >= intervalMs;
  }

  async maybeRun(directory?: string): Promise<DreamingRunResult | null> {
    if (!(await this.shouldRun())) return null;
    try {
      return await this.run(directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("another process") || message.includes("already running")) {
        log("dreaming: skipped due to lock contention", { error: message });
        return null;
      }
      if (message === "dreaming_provider_unavailable") {
        log("dreaming: skipped (provider unavailable)", { error: message });
        return null;
      }
      throw error;
    }
  }

  /** Manual or gated run. Does not re-check interval; caller uses maybeRun for that. */
  async run(directory?: string): Promise<DreamingRunResult> {
    if (this.isRunning) {
      throw new Error("Dreaming already running");
    }
    const releaseLock = tryAcquireDreamingLock();
    if (!releaseLock) {
      throw new Error("Dreaming already running in another process");
    }
    this.isRunning = true;
    const result: DreamingRunResult = {
      groupsConsidered: 0,
      groupsMerged: 0,
      groupsSkipped: 0,
      groupsFailed: 0,
      groupsFlagged: 0,
      memoriesSoftDeleted: 0,
    };

    try {
      await ensureTursoReady();
      const groups = await findNearDuplicateGroupsForDreaming();
      const batch = groups.slice(0, CONFIG.dreaming.maxGroupsPerRun);
      result.groupsConsidered = batch.length;

      if (batch.length === 0) {
        writeState({ lastRunAt: Date.now() });
        return result;
      }

      const v2Client = getV2Client();
      if (!v2Client || !CONFIG.opencodeProvider || !CONFIG.opencodeModel) {
        log("dreaming: skipped (no opencode structured-output client)");
        throw new Error("dreaming_provider_unavailable");
      }

      const { generateStructuredOutput } = await import("./ai/opencode-provider.js");
      let abortedForProvider = false;

      for (const group of batch) {
        try {
          const decision = await generateStructuredOutput({
            client: v2Client,
            providerID: CONFIG.opencodeProvider,
            modelID: CONFIG.opencodeModel,
            ...(CONFIG.opencodeVariant ? { variant: CONFIG.opencodeVariant } : {}),
            systemPrompt:
              "You are a careful memory consolidation assistant. Return only structured JSON.",
            userPrompt: buildMergePrompt(group),
            schema: dreamingActionSchema,
            directory,
          });

          const memberIds = new Set([
            group.representative.id,
            ...group.duplicates.map((d) => d.id),
          ]);

          if (decision.action === "keep") {
            result.groupsSkipped++;
            continue;
          }

          if (decision.action === "flag") {
            const flagged = await this.applyFlag(group, decision.reason);
            if (flagged) result.groupsFlagged++;
            else result.groupsSkipped++;
            continue;
          }

          if (
            (decision.action !== "merge" &&
              decision.action !== "update" &&
              decision.action !== "supersede") ||
            !decision.content?.trim()
          ) {
            result.groupsSkipped++;
            continue;
          }

          const keepId =
            decision.keepId && memberIds.has(decision.keepId)
              ? decision.keepId
              : group.representative.id;
          const dropIds = (decision.dropIds || [])
            .filter((id) => memberIds.has(id) && id !== keepId)
            .filter((id, idx, arr) => arr.indexOf(id) === idx);
          const finalDrop =
            dropIds.length > 0 ? dropIds : [...memberIds].filter((id) => id !== keepId);

          if (finalDrop.length === 0) {
            result.groupsSkipped++;
            continue;
          }

          const metaKey = decision.action === "supersede" ? "supersededBy" : "mergedInto";
          // Always preserve the keep row's own container_tag (critical for
          // cross-project groups where keepId may not be the representative).
          const outcome = await this.applyDreamingAction(
            keepId,
            decision.content.trim(),
            finalDrop,
            metaKey,
            decision.action
          );
          if (outcome.applied) {
            result.groupsMerged++;
            result.memoriesSoftDeleted += outcome.softDeleted;
          } else {
            result.groupsSkipped++;
          }
        } catch (error) {
          result.groupsFailed++;
          const errMsg = error instanceof Error ? error.message : String(error);
          log("dreaming: group failed", { error: errMsg });
          // Auth / provider outages will fail every remaining group the same way.
          if (/ProviderRequestError|API_KEY is not set|401|Unauthorized/i.test(errMsg)) {
            const processed =
              result.groupsMerged +
              result.groupsSkipped +
              result.groupsFlagged +
              result.groupsFailed;
            const remaining = Math.max(0, result.groupsConsidered - processed);
            result.groupsFailed += remaining;
            abortedForProvider = true;
            log("dreaming: aborting remaining groups after provider failure", { remaining });
            break;
          }
        }
      }

      const onlyFailures =
        result.groupsConsidered > 0 &&
        result.groupsMerged === 0 &&
        result.groupsFlagged === 0 &&
        result.groupsSkipped === 0 &&
        result.groupsFailed > 0 &&
        (abortedForProvider || result.groupsFailed === result.groupsConsidered);
      if (onlyFailures) {
        // Do not advance the schedule when nothing could be processed.
        log("dreaming: run complete with only failures; not advancing lastRunAt", result);
      } else {
        writeState({ lastRunAt: Date.now() });
        log("dreaming: run complete", result);
      }
      return result;
    } finally {
      this.isRunning = false;
      releaseLock();
    }
  }

  private async applyFlag(group: DreamingNearDupGroup, reason?: string): Promise<boolean> {
    const ids = [group.representative.id, ...group.duplicates.map((d) => d.id)];
    const shards = [
      ...(await tursoShardManager.getAllShards("user", "")),
      ...(await tursoShardManager.getAllShards("project", "")),
    ];
    let any = false;
    for (const id of ids) {
      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const row = await tursoVectorSearch.getMemoryById(db, id);
        if (!row) continue;
        const ok = await tursoVectorSearch.patchMemoryMetadata(db, id, {
          contradictionWith: ids.filter((other) => other !== id),
          contradictionReason: reason || "Unresolved contradiction during dreaming",
          contradictionFlaggedAt: Date.now(),
        });
        if (ok) any = true;
        break;
      }
    }
    return any;
  }

  private async applyDreamingAction(
    keepId: string,
    content: string,
    dropIds: string[],
    dropMetaKey: "mergedInto" | "supersededBy",
    action: "merge" | "update" | "supersede"
  ): Promise<{ applied: boolean; softDeleted: number }> {
    const shards = [
      ...(await tursoShardManager.getAllShards("user", "")),
      ...(await tursoShardManager.getAllShards("project", "")),
    ];

    let keepShard = null;
    let keepRow: Record<string, unknown> | null = null;
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const row = await tursoVectorSearch.getMemoryById(db, keepId);
      if (row) {
        keepShard = shard;
        keepRow = row;
        break;
      }
    }
    if (!keepShard || !keepRow) return { applied: false, softDeleted: 0 };
    if (Number(keepRow.is_pinned ?? 0) === 1) return { applied: false, softDeleted: 0 };

    // Soft-delete drops first so we never rewrite keep if nothing can be retired.
    let softDeleted = 0;
    for (const dropId of dropIds) {
      for (const shard of shards) {
        const dropDb = await tursoConnectionManager.getConnection(shard.dbPath);
        const dropRow = await tursoVectorSearch.getMemoryById(dropDb, dropId);
        if (!dropRow) continue;
        if (Number(dropRow.is_pinned ?? 0) === 1) continue;
        const ok = await tursoVectorSearch.softDeleteVector(dropDb, dropId, {
          [dropMetaKey]: keepId,
        });
        if (ok) softDeleted++;
        break;
      }
    }
    if (softDeleted === 0) {
      log("dreaming: skipped keep rewrite (no drops soft-deleted)", {
        keepId,
        dropIds,
        action,
      });
      return { applied: false, softDeleted: 0 };
    }

    await embeddingService.warmup();
    const vector = await embeddingService.embedWithTimeout(content, { task: "document" });
    const existingTags = keepRow.tags ? String(keepRow.tags) : "";
    const tags = existingTags
      ? existingTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    let tagsVector: Float32Array | undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags), {
        task: "document",
      });
    }

    const meta =
      keepRow.metadata && typeof keepRow.metadata === "string"
        ? (JSON.parse(keepRow.metadata) as Record<string, unknown>)
        : {};
    const mergedFrom = Array.isArray(meta.mergedFrom) ? [...(meta.mergedFrom as string[])] : [];
    for (const id of dropIds) {
      if (!mergedFrom.includes(id)) mergedFrom.push(id);
    }
    meta.mergedFrom = mergedFrom;
    meta.source = typeof meta.source === "string" ? meta.source : "dreaming";
    meta.dreamingAction = action;

    const db = await tursoConnectionManager.getConnection(keepShard.dbPath);
    const updatedAt = Date.now();
    const isPinned = Number(keepRow.is_pinned ?? 0) === 1 ? 1 : 0;
    const keepContainerTag = String(keepRow.container_tag);

    await db.transaction("write", async (tx) => {
      await tx.execute({ sql: `DELETE FROM memories WHERE id = ?`, args: [keepId] });
      await tx.execute({
        sql: `
          INSERT INTO memories (
            id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
            metadata, session_id, display_name, user_name, user_email, project_path, project_name, git_repo_url,
            is_pinned, deleted_at
          ) VALUES (?, ?, vector32(?), ${tagsVector ? "vector32(?)" : "NULL"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `,
        args: [
          keepId,
          content,
          JSON.stringify(Array.from(vector)),
          ...(tagsVector ? [JSON.stringify(Array.from(tagsVector))] : []),
          keepContainerTag,
          tags.length > 0 ? tags.join(",") : null,
          keepRow.type ? String(keepRow.type) : null,
          Number(keepRow.created_at),
          updatedAt,
          JSON.stringify(meta),
          keepRow.session_id ? String(keepRow.session_id) : null,
          keepRow.display_name ? String(keepRow.display_name) : null,
          keepRow.user_name ? String(keepRow.user_name) : null,
          keepRow.user_email ? String(keepRow.user_email) : null,
          keepRow.project_path ? String(keepRow.project_path) : null,
          keepRow.project_name ? String(keepRow.project_name) : null,
          keepRow.git_repo_url ? String(keepRow.git_repo_url) : null,
          isPinned,
        ],
      });
    });

    return { applied: true, softDeleted };
  }
}

export const dreamingService = new DreamingService();
