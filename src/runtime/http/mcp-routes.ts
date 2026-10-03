import type { MemoryType } from "../../types/index.js";
import type { MemoryScope } from "../../memory/client.js";
import {
  mcpGetMemories,
  mcpSearchMemories,
  mcpTimelineMemories,
  mcpWriteMemory,
} from "../../memory/tool/index.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Handle `/api/mcp/*` progressive memory routes for the shared runtime.
 * These return **compact** MCP shapes (snippet/score). Full plugin shapes live
 * under `/api/runtime/tool` — see `runtime-routes.ts`.
 * Returns `null` when the path is not an MCP API route.
 */
export async function handleMcpApiRoute(
  req: Request,
  path: string,
  method: string
): Promise<Response | null> {
  if (!path.startsWith("/api/mcp/")) return null;

  if (path === "/api/mcp/search" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      query?: string;
      limit?: number;
      scope?: MemoryScope;
      cwd?: string;
      platformSource?: string;
    };
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd();
    const result = await mcpSearchMemories(
      {
        query: body.query ?? "",
        limit: body.limit,
        scope: body.scope,
      },
      { directory: cwd, platformSource: body.platformSource }
    );
    return jsonResponse(result);
  }

  if (path === "/api/mcp/timeline" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      limit?: number;
      scope?: MemoryScope;
      cwd?: string;
      platformSource?: string;
    };
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd();
    const result = await mcpTimelineMemories(
      {
        limit: body.limit,
        scope: body.scope,
      },
      { directory: cwd, platformSource: body.platformSource }
    );
    return jsonResponse(result);
  }

  if (path === "/api/mcp/get" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const result = await mcpGetMemories(ids);
    return jsonResponse(result);
  }

  if (path === "/api/mcp/write" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      action?: "add" | "forget" | "profile";
      content?: string;
      tags?: string;
      type?: MemoryType;
      memoryId?: string;
      cwd?: string;
      platformSource?: string;
    };
    if (!body.action) {
      return jsonResponse({ success: false, error: "action required" }, 400);
    }
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd();
    const result = await mcpWriteMemory(
      {
        action: body.action,
        content: body.content,
        tags: body.tags,
        type: body.type,
        memoryId: body.memoryId,
      },
      { directory: cwd, platformSource: body.platformSource ?? "mcp" }
    );
    return jsonResponse(result);
  }

  return null;
}
