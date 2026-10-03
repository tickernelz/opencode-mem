import type { MemoryType } from "../../types/index.js";
import type { MemoryScope } from "../../memory/client.js";
import { executeMemoryTool } from "../../memory/tool/index.js";
import type { MemoryToolMode } from "../../memory/tool/types.js";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Internal shared-runtime HTTP API with **full plugin shapes** (content,
 * similarity, …). MCP progressive compression lives only under `/api/mcp/*`.
 *
 * Returns `null` when the path is not a runtime API route.
 */
export async function handleRuntimeApiRoute(
  req: Request,
  path: string,
  method: string
): Promise<Response | null> {
  if (!path.startsWith("/api/runtime/")) return null;

  if (path === "/api/runtime/tool" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
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
      cwd?: string;
      platformSource?: string;
    };
    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd();
    const raw = await executeMemoryTool(
      {
        mode: body.mode,
        content: body.content,
        query: body.query,
        tags: body.tags,
        type: body.type,
        memoryId: body.memoryId,
        limit: body.limit,
        scope: body.scope,
        fromPath: body.fromPath,
        fromHash: body.fromHash,
        outputPath: body.outputPath,
        inputPath: body.inputPath,
        dryRun: body.dryRun,
        allowLinkedSource: body.allowLinkedSource,
      },
      { directory: cwd, platformSource: body.platformSource }
    );
    try {
      return jsonResponse(JSON.parse(raw));
    } catch {
      return jsonResponse({ success: false, error: "Invalid tool response" }, 500);
    }
  }

  return null;
}
