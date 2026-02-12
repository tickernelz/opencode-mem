import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { handleStats } from "./api-handlers.js";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";

type MemorySearchArgs = {
  query: string;
  tag?: string;
  limit?: number;
};

type MemoryListArgs = {
  tag?: string;
  limit?: number;
};

type MemoryTimelineArgs = {
  memoryId: string;
  tag?: string;
  before?: number;
  after?: number;
  scanLimit?: number;
};

type TimelineMemory = {
  id: string;
  content: string;
  createdAt: string;
};

let memoryMcpServer: McpServer | null = null;

function resolveTag(directory: string, tag?: string): string {
  return tag || getTags(directory).project.tag;
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  return [];
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function normalizeCreatedAt(value: unknown): string {
  if (typeof value === "string") return value;

  const numValue = Number(value);
  if (Number.isFinite(numValue) && numValue > 0) {
    return new Date(numValue).toISOString();
  }

  return new Date().toISOString();
}

function toTimelineMemory(memory: any): TimelineMemory {
  return {
    id: memory.id,
    content: memory.summary || memory.content || "",
    createdAt: normalizeCreatedAt(memory.createdAt),
  };
}

export async function searchMemoryHistory(directory: string, args: MemorySearchArgs) {
  const tag = resolveTag(directory, args.tag);
  const limit = clampLimit(args.limit, 10, 100);
  const result = await memoryClient.searchMemories(args.query, tag);

  if (!result.success) {
    return { success: false as const, error: result.error || "Memory search failed" };
  }

  const results = (result.results || []).slice(0, limit).map((item: any) => ({
    id: item.id,
    content: item.memory || item.chunk || "",
    similarity: typeof item.similarity === "number" ? item.similarity : 0,
    tags: parseTags(item.tags),
    createdAt: normalizeCreatedAt(item.createdAt || item.metadata?.createdAt),
  }));

  return {
    success: true as const,
    query: args.query,
    tag,
    count: results.length,
    total: result.total || results.length,
    results,
  };
}

export async function listMemoryHistory(directory: string, args: MemoryListArgs = {}) {
  const tag = resolveTag(directory, args.tag);
  const limit = clampLimit(args.limit, 20, 200);
  const result = await memoryClient.listMemories(tag, limit);

  if (!result.success) {
    return { success: false as const, error: result.error || "Memory list failed" };
  }

  const memories = (result.memories || []).slice(0, limit).map((memory: any) => ({
    id: memory.id,
    content: memory.summary,
    tags: parseTags(memory.metadata?.tags),
    createdAt: normalizeCreatedAt(memory.createdAt),
  }));

  return {
    success: true as const,
    tag,
    count: memories.length,
    memories,
  };
}

export async function getMemoryStats() {
  const result = await handleStats();
  if (!result.success || !result.data) {
    return { success: false as const, error: result.error || "Stats unavailable" };
  }

  return {
    success: true as const,
    stats: result.data,
  };
}

export async function getMemoryTimeline(directory: string, args: MemoryTimelineArgs) {
  const tag = resolveTag(directory, args.tag);
  const before = clampLimit(args.before, 3, 20);
  const after = clampLimit(args.after, 3, 20);
  const scanLimit = Math.max(before + after + 1, clampLimit(args.scanLimit, 200, 1000));

  const listResult = await memoryClient.listMemories(tag, scanLimit);
  if (!listResult.success) {
    return { success: false as const, error: listResult.error || "Memory list failed" };
  }

  const chronological = (listResult.memories || [])
    .map((memory: any) => toTimelineMemory(memory))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const anchorIndex = chronological.findIndex((memory) => memory.id === args.memoryId);
  if (anchorIndex === -1) {
    return {
      success: false as const,
      error: `Memory not found: ${args.memoryId}`,
      searched: chronological.length,
      tag,
    };
  }

  const start = Math.max(0, anchorIndex - before);
  const end = Math.min(chronological.length, anchorIndex + after + 1);

  return {
    success: true as const,
    tag,
    memoryId: args.memoryId,
    before,
    after,
    totalContext: end - start,
    timeline: chronological.slice(start, end),
  };
}

function createMcpToolText(title: string, payload: unknown): string {
  return `${title}\n${JSON.stringify(payload, null, 2)}`;
}

export function createMemoryMcpServer(directory: string): McpServer {
  const server = new McpServer({ name: "opencode-mem-search", version: "1.0.0" });

  server.registerTool(
    "memory_search",
    {
      description: "Semantic search across project memories.",
      inputSchema: {
        query: z.string().min(1),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, tag, limit }) => {
      const payload = await searchMemoryHistory(directory, { query, tag, limit });
      return {
        content: [{ type: "text", text: createMcpToolText("memory_search", payload) }],
        structuredContent: payload,
      };
    }
  );

  server.registerTool(
    "memory_list",
    {
      description: "List recent memories for a project tag.",
      inputSchema: {
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ tag, limit }) => {
      const payload = await listMemoryHistory(directory, { tag, limit });
      return {
        content: [{ type: "text", text: createMcpToolText("memory_list", payload) }],
        structuredContent: payload,
      };
    }
  );

  server.registerTool(
    "memory_stats",
    {
      description: "Get high-level memory storage statistics.",
      inputSchema: {},
    },
    async () => {
      const payload = await getMemoryStats();
      return {
        content: [{ type: "text", text: createMcpToolText("memory_stats", payload) }],
        structuredContent: payload,
      };
    }
  );

  return server;
}

export function getOrCreateMemoryMcpServer(directory: string): McpServer {
  if (!memoryMcpServer) {
    memoryMcpServer = createMemoryMcpServer(directory);
  }

  return memoryMcpServer;
}
