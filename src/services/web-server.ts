import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { WebServerLock } from "./web-server-lock.js";
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

interface WebServerConfig {
  port: number;
  host: string;
  enabled: boolean;
}

export class WebServer {
  private server: any = null;
  private config: WebServerConfig;
  private lock: WebServerLock;
  private isOwner: boolean = false;

  constructor(config: WebServerConfig) {
    this.config = config;
    this.lock = new WebServerLock();
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      log("Web server disabled in config");
      return;
    }

    try {
      this.isOwner = await this.lock.acquire(this.config.port, this.config.host);

      if (!this.isOwner) {
        log("Web server already running, joined existing instance");
        return;
      }

      this.server = Bun.serve({
        port: this.config.port,
        hostname: this.config.host,
        fetch: this.handleRequest.bind(this),
      });

      log("Web server started", {
        url: `http://${this.config.host}:${this.config.port}`,
      });
    } catch (error) {
      log("Web server failed to start", { error: String(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const shouldStop = await this.lock.release();

    if (shouldStop && this.server) {
      this.server.stop();
      this.server = null;
      log("Web server stopped (last instance)");
    } else if (!shouldStop) {
      log("Web server kept alive (other instances running)");
    }
  }

  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    log("Web request", { method, path });

    try {
      if (path === "/" || path === "/index.html") {
        return this.serveStaticFile("index.html", "text/html");
      }

      if (path === "/styles.css") {
        return this.serveStaticFile("styles.css", "text/css");
      }

      if (path === "/app.js") {
        return this.serveStaticFile("app.js", "application/javascript");
      }

      if (path === "/api/tags" && method === "GET") {
        const result = await handleListTags();
        return this.jsonResponse(result);
      }

      if (path === "/api/memories" && method === "GET") {
        const tag = url.searchParams.get("tag") || undefined;
        const page = parseInt(url.searchParams.get("page") || "1");
        const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
        const result = await handleListMemories(tag, page, pageSize);
        return this.jsonResponse(result);
      }

      if (path === "/api/memories" && method === "POST") {
        const body = await req.json() as any;
        const result = await handleAddMemory(body);
        return this.jsonResponse(result);
      }

      if (path.startsWith("/api/memories/") && method === "DELETE") {
        const id = path.split("/").pop();
        if (!id) {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const result = await handleDeleteMemory(id);
        return this.jsonResponse(result);
      }

      if (path.startsWith("/api/memories/") && method === "PUT") {
        const id = path.split("/").pop();
        if (!id) {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const body = await req.json() as any;
        const result = await handleUpdateMemory(id, body);
        return this.jsonResponse(result);
      }

      if (path === "/api/memories/bulk-delete" && method === "POST") {
        const body = await req.json() as any;
        const result = await handleBulkDelete(body.ids || []);
        return this.jsonResponse(result);
      }

      if (path === "/api/search" && method === "GET") {
        const query = url.searchParams.get("q");
        const tag = url.searchParams.get("tag") || undefined;
        const page = parseInt(url.searchParams.get("page") || "1");
        const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
        
        if (!query) {
          return this.jsonResponse({ success: false, error: "query parameter required" });
        }
        
        const result = await handleSearch(query, tag, page, pageSize);
        return this.jsonResponse(result);
      }

      if (path === "/api/stats" && method === "GET") {
        const result = await handleStats();
        return this.jsonResponse(result);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      log("Web request error", { method, path, error: String(error) });
      return this.jsonResponse({
        success: false,
        error: String(error),
      }, 500);
    }
  }

  private serveStaticFile(filename: string, contentType: string): Response {
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
      log("Static file error", { filename, error: String(error) });
      return new Response("File not found", { status: 404 });
    }
  }

  private jsonResponse(data: any, status: number = 200): Response {
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
}

export async function startWebServer(config: WebServerConfig): Promise<WebServer> {
  const server = new WebServer(config);
  await server.start();
  return server;
}
