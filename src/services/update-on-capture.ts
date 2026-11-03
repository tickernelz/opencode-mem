import { sanitizeMemoryContent } from "./privacy.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";

export type UpdateOnCaptureAction = "add" | "update" | "supersede";

export interface UpdateOnCaptureCandidate {
  id: string;
  content: string;
  similarity: number;
  isPinned?: boolean;
}

export interface UpdateOnCaptureDecision {
  action: UpdateOnCaptureAction;
  targetId?: string;
  content?: string;
  reason?: string;
}

export type UpdateOnCaptureMemoryClient = {
  addMemory: (
    content: string,
    containerTag: string,
    metadata?: Record<string, unknown>
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
  updateMemory: (
    id: string,
    data: {
      content?: string;
      type?: MemoryType;
      tags?: string[];
      metadataPatch?: Record<string, unknown>;
    }
  ) => Promise<{ success: boolean; error?: string }>;
  deleteMemory: (
    memoryId: string,
    metaPatch?: Record<string, unknown>
  ) => Promise<{ success: boolean; error?: string }>;
  getMemoryById: (memoryId: string) => Promise<{
    success: boolean;
    memory?: { id: string; content: string; isPinned: boolean };
    error?: string;
  }>;
};

export interface PersistCaptureInput {
  summary: string;
  type: string;
  tags: string[];
  containerTag: string;
  metadata: {
    source: "auto-capture";
    type: MemoryType | string;
    tags: string[];
    sessionID: string;
    promptId: string;
    captureTimestamp: number;
    displayName?: string;
    userName?: string;
    userEmail?: string;
    projectPath?: string;
    projectName?: string;
    gitRepoUrl?: string;
  };
}

/** Drop pinned rows and truncate to the configured candidate cap. */
export function filterUpdateOnCaptureCandidates(
  candidates: UpdateOnCaptureCandidate[],
  maxCandidates = CONFIG.updateOnCaptureMaxCandidates
): UpdateOnCaptureCandidate[] {
  return candidates
    .filter((c) => Number(c.isPinned) !== 1 && c.isPinned !== true)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(1, maxCandidates));
}

export function buildUpdateOnCaptureDecisionPrompt(
  summary: string,
  candidates: UpdateOnCaptureCandidate[]
): string {
  summary = sanitizeMemoryContent(summary);
  const items = candidates.map((candidate) => {
    const c = { ...candidate, content: sanitizeMemoryContent(candidate.content) };
    return {
      id: c.id,
      similarity: Number(c.similarity.toFixed(3)),
      content: c.content.length > 800 ? `${c.content.slice(0, 800)}…` : c.content,
    };
  });
  return `You decide how to store a new auto-captured memory relative to similar existing memories.

New memory draft:
${summary}

Similar existing memories (JSON):
${JSON.stringify(items, null, 2)}

Choose exactly one action:
- "add": new distinct fact; keep existing memories unchanged.
- "update": rewrite targetId in place with the corrected/current content (use "content").
- "supersede": save the new memory and soft-delete targetId (outdated fact replaced).

Rules:
- Prefer "add" when unsure or when memories are only loosely related.
- Use "update" / "supersede" only when the new draft clearly updates or replaces the same fact.
- targetId MUST be one of the candidate ids when action is update or supersede.
- For "update", "content" MUST retain important details (paths, commands, why something failed).
- Do NOT invent facts. Do NOT touch pinned memories (already excluded).
- Return structured JSON only.`;
}

/**
 * Apply an LLM decision. Invalid update/supersede targets fall back to add.
 * Returns the persisted memory id (new or updated).
 */
export async function applyUpdateOnCaptureDecision(
  client: UpdateOnCaptureMemoryClient,
  decision: UpdateOnCaptureDecision,
  input: PersistCaptureInput,
  candidateIds: Set<string>
): Promise<{ success: boolean; id?: string; action: UpdateOnCaptureAction; error?: string }> {
  const fallbackAdd = async () => {
    const result = await client.addMemory(input.summary, input.containerTag, input.metadata as any);
    if (!result.success) {
      return { success: false as const, action: "add" as const, error: result.error };
    }
    return { success: true as const, id: result.id, action: "add" as const };
  };

  const action = decision.action || "add";
  if (action === "add") {
    return fallbackAdd();
  }

  const targetId = decision.targetId;
  if (!targetId || !candidateIds.has(targetId)) {
    log("update-on-capture: invalid targetId, falling back to add", {
      action,
      targetId,
    });
    return fallbackAdd();
  }

  const existing = await client.getMemoryById(targetId);
  if (!existing.success || !existing.memory || existing.memory.isPinned) {
    log("update-on-capture: target missing or pinned, falling back to add", {
      action,
      targetId,
    });
    return fallbackAdd();
  }

  if (action === "update") {
    const content = (decision.content || input.summary).trim();
    if (!content) return fallbackAdd();
    const updated = await client.updateMemory(targetId, {
      content,
      type: input.type as MemoryType,
      tags: input.tags,
      metadataPatch: {
        source: "auto-capture",
        updatedByCapture: true,
        promptId: input.metadata.promptId,
        sessionID: input.metadata.sessionID,
        captureTimestamp: input.metadata.captureTimestamp,
      },
    });
    if (!updated.success) {
      return { success: false, action: "update", error: updated.error };
    }
    return { success: true, id: targetId, action: "update" };
  }

  // supersede
  const added = await client.addMemory(input.summary, input.containerTag, input.metadata as any);
  if (!added.success || !added.id) {
    return { success: false, action: "supersede", error: added.error || "add failed" };
  }
  const deleted = await client.deleteMemory(targetId, { supersededBy: added.id });
  if (!deleted.success) {
    log("update-on-capture: supersede soft-delete failed; rolling back new memory", {
      targetId,
      newId: added.id,
      error: deleted.error,
    });
    // Keep store consistent: don't leave both old (active) and new (active).
    await client.deleteMemory(added.id, { supersededRollback: true });
    return {
      success: false,
      action: "supersede",
      error: deleted.error || "failed to soft-delete superseded memory",
    };
  }
  return { success: true, id: added.id, action: "supersede" };
}
