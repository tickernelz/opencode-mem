import { CONFIG } from "../config.js";
import { memoryClient, type MemoryScope } from "./client.js";
import { log } from "./logger.js";
import type { SearchResult } from "./turso/types.js";

export type RecallMode = "recent" | "relevant" | "both";
export type RecallScopeSetting = "project" | "all-projects" | "default";

export interface RecallMemory {
  id: string;
  memory: string;
  similarity?: number;
  selection?: "recent" | "semantic";
  createdAt?: number | string;
  projectName?: string;
  containerTag?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export const PROJECT_BOOST = 0.05;

/**
 * Relevance-based recall must re-run against each new user message (issue #460).
 * Legacy `"recent"` listing keeps the historical injectOn gate (`first` vs `always`).
 */
export function shouldRefreshRecallOnPrompt(
  recall: RecallMode,
  injectOn: "first" | "always"
): boolean {
  if (injectOn === "always") return true;
  return recall === "relevant" || recall === "both";
}

export function resolveRecallScope(
  recallScope: RecallScopeSetting,
  defaultScope: "project" | "all-projects"
): MemoryScope {
  if (recallScope === "default") return defaultScope;
  return recallScope;
}

export function applyProjectBoost(
  results: RecallMemory[],
  currentContainerTag: string,
  boost = PROJECT_BOOST
): RecallMemory[] {
  return results
    .map((r) => ({
      ...r,
      similarity:
        r.similarity === undefined
          ? undefined
          : Math.min(
              1,
              r.similarity + (r.containerTag && r.containerTag === currentContainerTag ? boost : 0)
            ),
    }))
    .sort((a, b) => (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity));
}

export function filterRecallResults(
  results: RecallMemory[],
  filters: { excludeSessionId?: string; createdAfter?: number }
): RecallMemory[] {
  return results.filter((r) => {
    if (filters.excludeSessionId) {
      const sid =
        r.sessionId ??
        (typeof r.metadata?.sessionID === "string" ? r.metadata.sessionID : undefined);
      if (sid === filters.excludeSessionId) return false;
    }
    if (filters.createdAfter !== undefined) {
      const t = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : Number(r.createdAt);
      if (Number.isFinite(t) && t < filters.createdAfter) return false;
    }
    return true;
  });
}

export function mergeBoth(
  relevant: RecallMemory[],
  recent: RecallMemory[],
  maxMemories: number
): RecallMemory[] {
  const seen = new Set<string>();
  const out: RecallMemory[] = [];
  for (const r of relevant) {
    if (out.length >= maxMemories) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  for (const r of recent) {
    if (out.length >= maxMemories) break;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function searchResultToRecall(r: SearchResult): RecallMemory {
  const meta = r.metadata;
  const sessionId =
    typeof (r as { sessionId?: string }).sessionId === "string"
      ? (r as { sessionId?: string }).sessionId
      : typeof meta?.sessionID === "string"
        ? meta.sessionID
        : undefined;
  return {
    id: r.id,
    memory: r.memory,
    similarity: r.similarity,
    selection: "semantic",
    createdAt: r.createdAt,
    projectName: r.projectName,
    containerTag: (r as { containerTag?: string }).containerTag,
    metadata: meta,
    sessionId,
  };
}

function listRowToRecall(m: {
  id: string;
  summary: string;
  createdAt?: string;
  projectName?: string;
  metadata?: Record<string, unknown>;
}): RecallMemory {
  const sessionId = typeof m.metadata?.sessionID === "string" ? m.metadata.sessionID : undefined;
  return {
    id: m.id,
    memory: m.summary,
    selection: "recent",
    createdAt: m.createdAt,
    projectName: m.projectName,
    metadata: m.metadata,
    sessionId,
  };
}

export interface LoadRecallOptions {
  containerTag: string;
  sessionID: string;
  queryText: string | null;
  maxMemories: number;
  recall: RecallMode;
  recallScope: RecallScopeSetting;
  defaultScope: "project" | "all-projects";
  excludeCurrentSession: boolean;
  maxAgeDays?: number;
  similarityThreshold: number;
}

/**
 * Select memories for chat auto-injection according to chatMessage.recall.
 * Falls back to recent listing when relevant/both is requested but no query text
 * is available (e.g. V2 context rehydrate without a fresh prompt).
 */
export async function loadRecallMemories(opts: LoadRecallOptions): Promise<RecallMemory[]> {
  const scope = resolveRecallScope(opts.recallScope, opts.defaultScope);
  const filters = {
    excludeSessionId: opts.excludeCurrentSession ? opts.sessionID : undefined,
    createdAfter: opts.maxAgeDays ? Date.now() - opts.maxAgeDays * 86400000 : undefined,
  };
  const listFilters = {
    excludeSessionId: filters.excludeSessionId,
    createdAfter: filters.createdAfter,
  };

  let mode = opts.recall;
  if ((mode === "relevant" || mode === "both") && !opts.queryText?.trim()) {
    log("memory recall: no query text, falling back to recent", {
      sessionID: opts.sessionID,
      requested: mode,
    });
    mode = "recent";
  }

  const loadRecent = async (): Promise<RecallMemory[]> => {
    const listResult = await memoryClient.listMemories(
      opts.containerTag,
      opts.maxMemories,
      scope,
      listFilters
    );
    if (!listResult.success) return [];
    return listResult.memories.map(listRowToRecall);
  };

  const loadRelevant = async (): Promise<RecallMemory[]> => {
    const query = opts.queryText!.trim();
    // Over-fetch so session/age filters and project boost can still fill the slot budget.
    const fetchLimit = Math.max(opts.maxMemories * 3, opts.maxMemories);
    const searchRes = await memoryClient.searchMemories(query, opts.containerTag, scope, {
      limit: fetchLimit,
      similarityThreshold: opts.similarityThreshold,
    });
    if (!searchRes.success) return [];
    let results = searchRes.results.map(searchResultToRecall);
    results = filterRecallResults(results, filters);
    if (scope === "all-projects") {
      results = applyProjectBoost(results, opts.containerTag);
    }
    return results.slice(0, opts.maxMemories);
  };

  if (opts.maxMemories <= 0) return [];

  if (mode === "recent") {
    return loadRecent();
  }

  if (mode === "relevant") {
    return loadRelevant();
  }

  // both
  const relevant = await loadRelevant();
  if (relevant.length >= opts.maxMemories) return relevant.slice(0, opts.maxMemories);
  const recent = await loadRecent();
  return mergeBoth(relevant, recent, opts.maxMemories);
}

/** Convenience wrapper using CONFIG + session prompt text. */
export async function loadRecallMemoriesForSession(
  containerTag: string,
  sessionID: string,
  queryText: string | null
): Promise<RecallMemory[]> {
  const threshold =
    typeof CONFIG.chatMessage.similarityThreshold === "number"
      ? CONFIG.chatMessage.similarityThreshold
      : CONFIG.similarityThreshold;

  return loadRecallMemories({
    containerTag,
    sessionID,
    queryText,
    maxMemories: CONFIG.chatMessage.maxMemories ?? 3,
    recall: CONFIG.chatMessage.recall ?? "relevant",
    recallScope: CONFIG.chatMessage.recallScope ?? "default",
    defaultScope: CONFIG.memory.defaultScope ?? "project",
    excludeCurrentSession: CONFIG.chatMessage.excludeCurrentSession ?? true,
    maxAgeDays: CONFIG.chatMessage.maxAgeDays,
    similarityThreshold: threshold,
  });
}
