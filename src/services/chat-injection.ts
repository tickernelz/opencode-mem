export interface MessagePart {
  type: string;
  synthetic?: boolean;
  text?: string;
}

export interface Message {
  info: { role: string };
  parts: MessagePart[];
}

export interface SemanticResult {
  id: string;
  memory: string;
  similarity: number;
  [key: string]: unknown;
}

export interface RecentResult {
  id: string;
  summary: string;
  [key: string]: unknown;
}

export interface NormalizedMemory {
  id: string;
  text: string;
  similarity: number;
}

/**
 * Extract the last paragraph of the most recent non-synthetic assistant message.
 *
 * Rules:
 * - Only considers messages with `info.role === "assistant"`.
 * - Only uses parts where `type === "text"` and `synthetic` is falsy.
 * - Splits collected text on `"\n\n"` and returns the last non-empty paragraph.
 * - Result is capped at the final 500 characters via `slice(-500)`.
 * - Returns `undefined` when no qualifying assistant message or text exists.
 */
export function extractAssistantTail(messages: Message[]): string | undefined {
  let lastAssistant: Message | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.info.role === "assistant") {
      lastAssistant = m;
      break;
    }
  }

  if (!lastAssistant) return undefined;

  const nonSyntheticText = lastAssistant.parts
    .filter(
      (p): p is MessagePart & { text: string } =>
        p.type === "text" && !p.synthetic && typeof p.text === "string"
    )
    .map((p) => p.text)
    .join("\n\n");

  if (!nonSyntheticText.trim()) return undefined;

  const paragraphs = nonSyntheticText.split("\n\n");
  const lastParagraph = [...paragraphs].reverse().find((p) => p.trim().length > 0);

  if (!lastParagraph) return undefined;

  return lastParagraph.slice(-500);
}

/**
 * Build a semantic search query from the current user message and an optional
 * assistant tail. When `assistantTail` is provided it is appended after a blank
 * line so the embedding model receives useful conversational context.
 */
export function buildSemanticQuery(userMessage: string, assistantTail?: string): string {
  return [userMessage, assistantTail].filter(Boolean).join("\n\n");
}

/**
 * Merge semantic and recent memory results into a single, deduplicated list.
 *
 * Ordering rules:
 * 1. Semantic results come first (preserves relevance ranking).
 * 2. Remaining slots are filled with recent results not already included.
 * 3. Deduplication is by `id`.
 * 4. Total is capped at `maxMemories`.
 *
 * Recent results that have no semantic counterpart are assigned `similarity: 1.0`
 * to indicate they were selected by recency rather than vector similarity.
 */
export function mergeHybrid(
  semanticResults: SemanticResult[],
  recentResults: RecentResult[],
  maxMemories: number
): NormalizedMemory[] {
  const seen = new Set<string>();
  const merged: NormalizedMemory[] = [];

  for (const r of semanticResults) {
    if (merged.length >= maxMemories) break;
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push({ id: r.id, text: r.memory, similarity: r.similarity });
    }
  }

  for (const r of recentResults) {
    if (merged.length >= maxMemories) break;
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push({ id: r.id, text: r.summary, similarity: 1.0 });
    }
  }

  return merged;
}
