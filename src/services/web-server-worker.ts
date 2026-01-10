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

    if (path === "/api/tags" && method === "GET") {
      const result = await handleListTags();
      return jsonResponse(result);
    }

    if (path === "/api/memories" && method === "GET") {
      const tag = url.searchParams.get("tag") || undefined;
      const page = parseInt(url.searchParams.get("page") || "1");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
      const result = await handleListMemories(tag, page, pageSize);
      return jsonResponse(result);
    }

    if (path === "/api/memories" && method === "POST") {
      const body = await req.json() as any;
      const result = await handleAddMemory(body);
      return jsonResponse(result);
    }

    if (path.startsWith("/api/memories/") && method === "DELETE") {
      const id = path.split("/").pop();
      if (!id) {
        return jsonResponse({ success: false, error: "Invalid ID" });
      }
      const result = await handleDeleteMemory(id);
      return jsonResponse(result);
    }

    if (path.startsWith("/api/memories/") && method === "PUT") {
      const id = path.split("/").pop();
      if (!id) {
        return jsonResponse({ success: false, error: "Invalid ID" });
      }
      const body = await req.json() as any;
      const result = await handleUpdateMemory(id, body);
      return jsonResponse(result);
    }

    if (path === "/api/memories/bulk-delete" && method === "POST") {
      const body = await req.json() as any;
      const result = await handleBulkDelete(body.ids || []);
      return jsonResponse(result);
    }

    if (path === "/api/search" && method === "GET") {
      const query = url.searchParams.get("q");
      const tag = url.searchParams.get("tag") || undefined;
      const page = parseInt(url.searchParams.get("page") || "1");
      const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
      
      if (!query) {
        return jsonResponse({ success: false, error: "query parameter required" });
      }
      
      const result = await handleSearch(query, tag, page, pageSize);
      return jsonResponse(result);
    }

    if (path === "/api/stats" && method === "GET") {
      const result = await handleStats();
      return jsonResponse(result);
    }

    return new Response("Not Found", { status: 404 });
  } catch (error) {
    return jsonResponse({
      success: false,
      error: String(error),
    }, 500);
  }
}

function serveStaticFile(filename: string, contentType: string): Response {
  try {
    const webDir = join(__dirname, "..", "web");
    const filePath = join(webDir, filename);
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

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
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
