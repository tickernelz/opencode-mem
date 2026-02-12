import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleListTags,
  handleListMemories,
  handleAddMemory,
  handleDeleteMemory,
  handleBulkDelete,
  handleUpdateMemory,
  handleSearch,
  handleStats,
  handlePinMemory,
  handleUnpinMemory,
  handleRunCleanup,
  handleRunDeduplication,
  handleDetectMigration,
  handleRunMigration,
  handleDetectTagMigration,
  handleRunTagMigrationBatch,
  handleGetTagMigrationProgress,
  handleDeletePrompt,
  handleBulkDeletePrompts,
  handleGetUserProfile,
  handleGetProfileChangelog,
  handleGetProfileSnapshot,
  handleRefreshProfile,
} from "./api-handlers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WorkerMessage {
  type: "start" | "stop" | "status";
  port?: number;
  host?: string;
}

interface WorkerResponse {
  type: "started" | "stopped" | "error" | "status";
  url?: string;
  error?: string;
  running?: boolean;
}

let server: any = null;

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    const origin = getCorsOrigin(req);
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }

  const json = (data: any, status = 200) => jsonResponse(data, status, req);
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  try {
    if (path === "/" || path === "/index.html") {
      return serveStaticFile("index.html", "text/html");
    }

    if (path === "/styles.css") {
      return serveStaticFile("styles.css", "text/css");
    }

    if (path === "/app.js") {
      return serveStaticFile("app.js", "application/javascript");
    }

    if (path === "/favicon.ico") {
      return serveStaticFile("favicon.ico", "image/x-icon");
    }

    if (path === "/api/tags" && method === "GET") {
      const result = await handleListTags();
      return json(result);
    }

    if (path === "/api/memories" && method === "GET") {
      const tag = url.searchParams.get("tag") || undefined;
      const page = parseInt(url.searchParams.get("page") || "1");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
      const includePrompts = url.searchParams.get("includePrompts") !== "false";
      const result = await handleListMemories(tag, page, pageSize, includePrompts);
      return json(result);
    }

    if (path === "/api/memories" && method === "POST") {
      const body = (await req.json()) as any;
      const result = await handleAddMemory(body);
      return json(result);
    }

    if (path.startsWith("/api/memories/") && method === "DELETE") {
      const parts = path.split("/");
      const id = parts[3];
      if (!id || id === "bulk-delete") {
        return json({ success: false, error: "Invalid ID" });
      }
      const cascade = url.searchParams.get("cascade") === "true";
      const result = await handleDeleteMemory(id, cascade);
      return json(result);
    }

    if (path.startsWith("/api/memories/") && method === "PUT") {
      const id = path.split("/").pop();
      if (!id) {
        return json({ success: false, error: "Invalid ID" });
      }
      const body = (await req.json()) as any;
      const result = await handleUpdateMemory(id, body);
      return json(result);
    }

    if (path === "/api/memories/bulk-delete" && method === "POST") {
      const body = (await req.json()) as any;
      const cascade = body.cascade !== false;
      const result = await handleBulkDelete(body.ids || [], cascade);
      return json(result);
    }

    if (path === "/api/search" && method === "GET") {
      const query = url.searchParams.get("q");
      const tag = url.searchParams.get("tag") || undefined;
      const page = parseInt(url.searchParams.get("page") || "1");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "20");

      if (!query) {
        return json({ success: false, error: "query parameter required" });
      }

      const result = await handleSearch(query, tag, page, pageSize);
      return json(result);
    }

    if (path === "/api/stats" && method === "GET") {
      const result = await handleStats();
      return json(result);
    }

    if (path.match(/^\/api\/memories\/[^/]+\/pin$/) && method === "POST") {
      const id = path.split("/")[3];
      if (!id) {
        return json({ success: false, error: "Invalid ID" });
      }
      const result = await handlePinMemory(id);
      return json(result);
    }

    if (path.match(/^\/api\/memories\/[^/]+\/unpin$/) && method === "POST") {
      const id = path.split("/")[3];
      if (!id) {
        return json({ success: false, error: "Invalid ID" });
      }
      const result = await handleUnpinMemory(id);
      return json(result);
    }

    if (path === "/api/cleanup" && method === "POST") {
      const result = await handleRunCleanup();
      return json(result);
    }

    if (path === "/api/deduplicate" && method === "POST") {
      const result = await handleRunDeduplication();
      return json(result);
    }

    if (path === "/api/migration/detect" && method === "GET") {
      const result = await handleDetectMigration();
      return json(result);
    }

    if (path === "/api/migration/tags/detect" && method === "GET") {
      const result = await handleDetectTagMigration();
      return json(result);
    }

    if (path === "/api/migration/tags/run-batch" && method === "POST") {
      const body = (await req.json()) as any;
      const batchSize = body?.batchSize || 5;
      const result = await handleRunTagMigrationBatch(batchSize);
      return json(result);
    }

    if (path === "/api/migration/tags/progress" && method === "GET") {
      const result = await handleGetTagMigrationProgress();
      return json(result);
    }

    if (path === "/api/migration/run" && method === "POST") {
      const body = (await req.json()) as any;
      const strategy = body.strategy || "fresh-start";
      if (strategy !== "fresh-start" && strategy !== "re-embed") {
        return json({ success: false, error: "Invalid strategy" });
      }
      const result = await handleRunMigration(strategy);
      return json(result);
    }

    if (path.startsWith("/api/prompts/") && method === "DELETE") {
      const parts = path.split("/");
      const id = parts[3];
      if (!id || id === "bulk-delete") {
        return json({ success: false, error: "Invalid ID" });
      }
      const cascade = url.searchParams.get("cascade") === "true";
      const result = await handleDeletePrompt(id, cascade);
      return json(result);
    }

    if (path === "/api/prompts/bulk-delete" && method === "POST") {
      const body = (await req.json()) as any;
      const cascade = body.cascade !== false;
      const result = await handleBulkDeletePrompts(body.ids || [], cascade);
      return json(result);
    }

    if (path === "/api/user-profile" && method === "GET") {
      const userId = url.searchParams.get("userId") || undefined;
      const result = await handleGetUserProfile(userId);
      return json(result);
    }

    if (path === "/api/user-profile/changelog" && method === "GET") {
      const profileId = url.searchParams.get("profileId");
      const limit = parseInt(url.searchParams.get("limit") || "5");
      if (!profileId) {
        return json({ success: false, error: "profileId parameter required" });
      }
      const result = await handleGetProfileChangelog(profileId, limit);
      return json(result);
    }

    if (path === "/api/user-profile/snapshot" && method === "GET") {
      const changelogId = url.searchParams.get("chlogId");
      if (!changelogId) {
        return json({ success: false, error: "changelogId parameter required" });
      }
      const result = await handleGetProfileSnapshot(changelogId);
      return json(result);
    }

    if (path === "/api/user-profile/refresh" && method === "POST") {
      const body = (await req.json().catch(() => ({}))) as any;
      const userId = body.userId || undefined;
      const result = await handleRefreshProfile(userId);
      return json(result);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    return json({ success: false, error: String(error) }, 500);
  }
}

function serveStaticFile(filename: string, contentType: string): Response {
  try {
    const webDir = join(__dirname, "..", "web");
    const filePath = join(webDir, filename);

    if (contentType.startsWith("image/")) {
      const content = readFileSync(filePath);
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    const content = readFileSync(filePath, "utf-8");

    return new Response(content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return new Response("File not found", { status: 404 });
  }
}

function getCorsOrigin(req?: Request): string {
  if (!req) return "";
  const origin = req.headers.get("Origin") || "";
  // Only allow requests from the web UI itself (same host)
  // This prevents external websites from reading memory data via CORS
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return origin;
  }
  return "";
}

function jsonResponse(data: any, status: number = 200, req?: Request): Response {
  const origin = getCorsOrigin(req);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case "start": {
        if (server) {
          self.postMessage({
            type: "error",
            error: "Server already running",
          } as WorkerResponse);
          return;
        }

        server = Bun.serve({
          port: message.port!,
          hostname: message.host!,
          fetch: handleRequest,
        });

        self.postMessage({
          type: "started",
          url: `http://${message.host}:${message.port}`,
        } as WorkerResponse);
        break;
      }

      case "stop": {
        if (server) {
          server.stop();
          server = null;
          self.postMessage({
            type: "stopped",
          } as WorkerResponse);
        } else {
          self.postMessage({
            type: "error",
            error: "Server not running",
          } as WorkerResponse);
        }
        break;
      }

      case "status": {
        self.postMessage({
          type: "status",
          running: server !== null,
        } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({
          type: "error",
          error: `Unknown message type: ${message.type}`,
        } as WorkerResponse);
        break;
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      error: String(error),
    } as WorkerResponse);
  }
};
