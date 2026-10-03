import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureSharedRuntimeClient, type SharedRuntimeClient } from "../runtime/client.js";
import { MCP_SEARCH_DEFAULT_LIMIT, MCP_TIMELINE_DEFAULT_LIMIT } from "../memory/tool/index.js";

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export async function createMcpServer(
  directory = process.cwd(),
  runtimeClient?: SharedRuntimeClient
): Promise<{
  server: McpServer;
  client: SharedRuntimeClient;
}> {
  const client = runtimeClient ?? (await ensureSharedRuntimeClient(directory));
  const server = new McpServer({
    name: "opencode-mem",
    version: "2.28.3",
  });

  server.registerTool(
    "memory_timeline",
    {
      description:
        "List recent project memories chronologically (compact id + createdAt + snippet). " +
        "Call at session start for continuity, then memory_get for full text. Prefer over dumping full memories.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(`Max memories (default ${MCP_TIMELINE_DEFAULT_LIMIT})`),
        scope: z
          .enum(["project", "all-projects"])
          .optional()
          .describe("Timeline scope (default: project)"),
      },
    },
    async ({ limit, scope }) => textResult(await client.timeline({ limit, scope }))
  );

  server.registerTool(
    "memory_search",
    {
      description:
        "Search project memory and return a compact index (id, score, snippet). " +
        "Use memory_get next to fetch full content for selected ids. Keeps token use low.",
      inputSchema: {
        query: z.string().describe("Technical keywords / tags to search for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(`Max results (default ${MCP_SEARCH_DEFAULT_LIMIT})`),
        scope: z
          .enum(["project", "all-projects"])
          .optional()
          .describe("Search scope (default: project)"),
      },
    },
    async ({ query, limit, scope }) => textResult(await client.search({ query, limit, scope }))
  );

  server.registerTool(
    "memory_get",
    {
      description:
        "Fetch full memory content by ids returned from memory_timeline or memory_search. Prefer batching ids.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("Memory ids to fetch"),
      },
    },
    async ({ ids }) => textResult(await client.get(ids))
  );

  server.registerTool(
    "memory_write",
    {
      description:
        "Mutate memory: add a memory, forget by id, or write an explicit profile preference.",
      inputSchema: {
        action: z.enum(["add", "forget", "profile"]),
        content: z.string().optional().describe("Required for add and profile write"),
        tags: z.string().optional().describe("Comma-separated tags for add"),
        type: z.string().optional().describe("Optional memory type for add"),
        memoryId: z.string().optional().describe("Required for forget"),
      },
    },
    async ({ action, content, tags, type, memoryId }) =>
      textResult(await client.write({ action, content, tags, type, memoryId }))
  );

  return { server, client };
}

export async function runMcpServer(directory = process.cwd()): Promise<void> {
  const { server } = await createMcpServer(directory);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
