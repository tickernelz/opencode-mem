import { isConfigured } from "../../config.js";
import type { MemoryType } from "../../types/index.js";
import { memoryClient, type MemoryScope } from "../client.js";
import { resolvePlatformSource } from "../../shared/platform-source.js";
import { executeMemoryTool } from "./execute.js";
import {
  MCP_SEARCH_DEFAULT_LIMIT,
  MCP_TIMELINE_DEFAULT_LIMIT,
  snippetFromContent,
  type MemoryToolContext,
} from "./types.js";

/** Compact index search for MCP progressive disclosure. */
export async function mcpSearchMemories(
  args: {
    query: string;
    limit?: number;
    scope?: MemoryScope;
  },
  ctx: MemoryToolContext
): Promise<object> {
  if (!args.query?.trim()) {
    return { success: false, error: "query required" };
  }

  const limit = Math.min(Math.max(args.limit ?? MCP_SEARCH_DEFAULT_LIMIT, 1), 20);
  const raw = await executeMemoryTool(
    {
      mode: "search",
      query: args.query,
      limit,
      scope: args.scope,
    },
    ctx
  );
  const parsed = JSON.parse(raw) as {
    success: boolean;
    error?: string;
    query?: string;
    count?: number;
    results?: Array<{
      id?: string;
      content?: string;
      similarity?: number;
      platformSource?: string;
    }>;
  };

  if (!parsed.success) {
    return { success: false, error: parsed.error ?? "search failed" };
  }

  return {
    success: true,
    query: parsed.query,
    count: parsed.results?.length ?? 0,
    results: (parsed.results ?? []).map((r) => ({
      id: r.id,
      score: r.similarity,
      snippet: snippetFromContent(String(r.content ?? "")),
      ...(r.platformSource ? { platformSource: r.platformSource } : {}),
    })),
    hint: "Call memory_get with promising ids to fetch full content.",
  };
}

/**
 * Chronological compact index for MCP progressive disclosure.
 * Use at session start (or after search) before memory_get.
 */
export async function mcpTimelineMemories(
  args: {
    limit?: number;
    scope?: MemoryScope;
  },
  ctx: MemoryToolContext
): Promise<object> {
  const limit = Math.min(Math.max(args.limit ?? MCP_TIMELINE_DEFAULT_LIMIT, 1), 20);
  const raw = await executeMemoryTool(
    {
      mode: "list",
      limit,
      scope: args.scope,
    },
    ctx
  );
  const parsed = JSON.parse(raw) as {
    success: boolean;
    error?: string;
    count?: number;
    memories?: Array<{
      id?: string;
      content?: string;
      createdAt?: string;
    }>;
  };

  if (!parsed.success) {
    return { success: false, error: parsed.error ?? "timeline failed" };
  }

  return {
    success: true,
    count: parsed.memories?.length ?? 0,
    memories: (parsed.memories ?? []).map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      snippet: snippetFromContent(String(m.content ?? "")),
    })),
    hint: "Call memory_get with promising ids to fetch full content. Use memory_search for topical queries.",
  };
}

/** Fetch full memories by id for MCP progressive disclosure. */
export async function mcpGetMemories(ids: string[]): Promise<object> {
  if (!isConfigured()) {
    return { success: false, error: "Memory system not configured properly." };
  }

  try {
    await memoryClient.ensureStorageReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Memory system failed to initialize: ${message}` };
  }

  const result = await memoryClient.getMemoriesByIds(ids);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true, count: result.memories.length, memories: result.memories };
}

/** Mutating MCP write surface: add | forget | profile. */
export async function mcpWriteMemory(
  args: {
    action: "add" | "forget" | "profile";
    content?: string;
    tags?: string;
    type?: MemoryType;
    memoryId?: string;
  },
  ctx: MemoryToolContext
): Promise<object> {
  const toolCtx: MemoryToolContext = {
    directory: ctx.directory,
    platformSource: resolvePlatformSource(ctx.platformSource ?? "mcp"),
  };
  if (args.action === "add") {
    return JSON.parse(
      await executeMemoryTool(
        { mode: "add", content: args.content, tags: args.tags, type: args.type },
        toolCtx
      )
    );
  }
  if (args.action === "forget") {
    return JSON.parse(
      await executeMemoryTool({ mode: "forget", memoryId: args.memoryId }, toolCtx)
    );
  }
  if (args.action === "profile") {
    return JSON.parse(await executeMemoryTool({ mode: "profile", content: args.content }, toolCtx));
  }
  return { success: false, error: `Unknown action: ${args.action}` };
}
