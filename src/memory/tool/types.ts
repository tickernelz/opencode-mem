import type { MemoryType } from "../../types/index.js";
import type { MemoryScope } from "../client.js";
import { platformSourceFromMetadata } from "../../shared/platform-source.js";

export type MemoryToolMode =
  | "add"
  | "search"
  | "profile"
  | "list"
  | "forget"
  | "help"
  | "migrate"
  | "list-shards"
  | "export"
  | "import";

export interface MemoryToolArgs {
  mode?: MemoryToolMode;
  content?: string;
  query?: string;
  tags?: string;
  type?: MemoryType;
  memoryId?: string;
  limit?: number;
  scope?: MemoryScope;
  fromPath?: string;
  fromHash?: string;
  outputPath?: string;
  inputPath?: string;
  dryRun?: boolean;
  allowLinkedSource?: boolean;
}

export interface MemoryToolContext {
  directory: string;
  /** Provenance stamp written into memory metadata on add. */
  platformSource?: string;
}

/** Default compact search limit for MCP progressive disclosure. */
export const MCP_SEARCH_DEFAULT_LIMIT = 5;
/** Default chronological timeline limit for MCP progressive disclosure. */
export const MCP_TIMELINE_DEFAULT_LIMIT = 10;
/** Max characters kept in an MCP search snippet. */
export const MCP_SNIPPET_MAX_CHARS = 160;

export function formatSearchResults(query: string, results: any, limit?: number): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r: any) => {
      const platformSource = platformSourceFromMetadata(r.metadata);
      return {
        id: r.id,
        content: r.memory || r.chunk,
        similarity: Math.round(r.similarity * 100),
        ...(platformSource ? { platformSource } : {}),
      };
    }),
  });
}

export function snippetFromContent(content: string, maxChars = MCP_SNIPPET_MAX_CHARS): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}
