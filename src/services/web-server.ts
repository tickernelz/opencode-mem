import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { corsPreflightResponse, disallowedCorsResponse, isAllowedBrowserOrigin } from "./cors.js";
import { getOrCreateAuthToken, isAuthorizedApiRequest } from "./auth-token.js";
import { WebAuth } from "./web-auth.js";
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
  handleAICleanup,
  handleApplyCleanup,
  handleUpdateProfileItem,
} from "./api-handlers.js";

/**
 * Runtime-portable HTTP server handle.
 *
 * Under Bun we delegate to `Bun.serve` which is the fastest path on that
 * runtime. Under Node we use `node:http` and adapt between IncomingMessage/
 * ServerResponse and the Web `Request`/`Response` primitives used by the
 * fetch-style handler.
 *
 * Both paths expose the same minimal surface — `stop()` and `url` — that the
 * rest of this class relies on, so the WebServer class itself does not need
 * to branch.
 */
interface PortableServerHandle {
  stop(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function serveFetch(opts: {
  port: number;
  hostname: string;
  fetch: (req: Request) => Promise<Response>;
}): PortableServerHandle {
  if (isBun) {
    const bunHandle = (
      globalThis as { Bun: { serve: (opts: unknown) => { stop: () => void } } }
    ).Bun.serve({
      port: opts.port,
      hostname: opts.hostname,
      fetch: opts.fetch,
    });
    return { stop: () => bunHandle.stop() };
  }

  // Node path: wrap node:http around the fetch-style handler. The adapter
  // converts IncomingMessage → Web Request and Web Response → ServerResponse.
  // Bodies stream both directions via the WHATWG Streams ↔ Node Streams
  // helpers that ship with Node 18+.
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let destroyed = false;
    const cleanup = () => {
      if (destroyed) return;
      destroyed = true;
      if (!res.writableEnded) res.destroy();
      if (!req.socket.destroyed) req.socket.destroy();
    };
    req.on("close", cleanup);
    req.socket.on("error", cleanup);
    req.socket.on("close", cleanup);

    try {
      const url = `http://${opts.hostname}:${opts.port}${req.url ?? "/"}`;
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const webReq = new Request(url, {
        method,
        headers: req.headers as Record<string, string>,
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
        ...(hasBody ? ({ duplex: "half" } as Record<string, unknown>) : {}),
      });

      const webRes = await opts.fetch(webReq);
      if (destroyed) return;
      res.statusCode = webRes.status;
      webRes.headers.forEach((value, name) => res.setHeader(name, value));
      res.setHeader("Connection", "close");

      if (webRes.body) {
        const src = Readable.fromWeb(
          webRes.body as unknown as Parameters<typeof Readable.fromWeb>[0]
        );
        res.on("close", () => {
          if (!src.destroyed) src.destroy();
        });
        src.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain");
      }
      if (!res.writableEnded) {
        res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  // Surface EADDRINUSE synchronously so callers can detect the
  // already-running-instance case the same way they do under Bun.
  let listenError: Error | undefined;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      listenError = err;
    }
  });
  // exclusive: false disables SO_EXCLUSIVEADDRUSE on Windows, allowing
  // rebind after a crashed predecessor left orphaned sockets behind.
  server.listen({ port: opts.port, host: opts.hostname, reuseAddr: true, exclusive: false });
  server.unref();
  server.timeout = 30000;
  server.keepAliveTimeout = 10000;
  server.headersTimeout = 11000;

  if (listenError) {
    throw listenError;
  }
  return {
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebServerConfig {
  port: number;
  host: string;
  enabled: boolean;
  auth?: WebAuth;
}

export class WebServer {
  private server: PortableServerHandle | null = null;
  private config: WebServerConfig;
  private isOwner: boolean = false;
  private startPromise: Promise<void> | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private onTakeoverCallback: (() => Promise<void>) | null = null;

  constructor(config: WebServerConfig) {
    this.config = config;
  }

  setOnTakeoverCallback(callback: () => Promise<void>): void {
    this.onTakeoverCallback = callback;
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this._start();
    return this.startPromise;
  }

  private async _start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      this.server = serveFetch({
        port: this.config.port,
        hostname: this.config.host,
        fetch: this.handleRequest.bind(this),
      });
      this.isOwner = true;
    } catch (error) {
      const errorMsg = String(error);

      if (
        errorMsg.includes("EADDRINUSE") ||
        errorMsg.includes("address already in use") ||
        /Failed to start server.*Is port \d+ in use/.test(errorMsg)
      ) {
        this.isOwner = false;
        this.server = null;
        this.startHealthCheckLoop();
      } else {
        this.isOwner = false;
        this.server = null;
        log("Web server failed to start", { error: errorMsg });
        throw error;
      }
    }
  }

  private startHealthCheckLoop(): void {
    if (this.healthCheckInterval) {
      return;
    }

    this.healthCheckInterval = setInterval(async () => {
      const isAvailable = await this.checkServerAvailable();

      if (!isAvailable) {
        this.stopHealthCheckLoop();
        await this.attemptTakeover();
      }
    }, 5000);
  }

  private stopHealthCheckLoop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async attemptTakeover(): Promise<void> {
    // prevent thundering herd: multiple non-owners racing to bind port
    const jitterMs = 500 + Math.random() * 1000;
    await new Promise((resolve) => setTimeout(resolve, jitterMs));

    if (await this.checkServerAvailable()) {
      this.startHealthCheckLoop();
      return;
    }

    try {
      // Reset startPromise so _start() can run again
      this.startPromise = null;
      await this._start();

      if (this.isOwner) {
        log("Web server takeover successful", { port: this.config.port });

        if (this.onTakeoverCallback) {
          try {
            await this.onTakeoverCallback();
          } catch (error) {
            log("Takeover callback error", { error: String(error) });
          }
        }
      }
    } catch (error) {
      this.startHealthCheckLoop();
    }
  }

  async stop(): Promise<void> {
    this.stopHealthCheckLoop();

    if (!this.isOwner || !this.server) {
      return;
    }

    this.server.stop();
    this.server = null;
    this.isOwner = false;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  isServerOwner(): boolean {
    return this.isOwner;
  }

  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  async checkServerAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getUrl()}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // --- HTTP request handling (inlined from web-server-worker.ts) ---

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const origin = req.headers.get("Origin");

    const auth = this.config.auth;
    const corsOptions = { httpAuthEnabled: auth?.isEnabled() ?? false };

    if (!isAllowedBrowserOrigin(origin, corsOptions)) {
      return disallowedCorsResponse();
    }

    if (method === "OPTIONS") {
      return corsPreflightResponse(req, corsOptions);
    }

    if (auth && auth.isEnabled()) {
      const authCheck = auth.check(req, path);
      if (!authCheck.ok && authCheck.response) {
        return authCheck.response;
      }
    }

    if (path.startsWith("/api/") && path !== "/api/health" && !isAuthorizedApiRequest(req)) {
      return this.jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    try {
      if (path === "/api/health" && method === "GET") {
        return this.jsonResponse({
          success: true,
          status: "ok",
          authEnabled: auth?.isEnabled() ?? false,
        });
      }

      if (path === "/" || path === "/index.html") {
        return this.serveStaticFile("index.html", "text/html");
      }

      if (path === "/styles.css") {
        return this.serveStaticFile("styles.css", "text/css");
      }

      if (path === "/app.js") {
        return this.serveStaticFile("app.js", "application/javascript");
      }

      if (path === "/i18n.js") {
        return this.serveStaticFile("i18n.js", "application/javascript");
      }

      if (path === "/favicon.ico") {
        return this.serveStaticFile("favicon.ico", "image/x-icon");
      }

      if (path === "/api/tags" && method === "GET") {
        const result = await handleListTags();
        return this.jsonResponse(result);
      }

      if (path === "/api/memories" && method === "GET") {
        const tag = url.searchParams.get("tag") || undefined;
        const page = parseInt(url.searchParams.get("page") || "1");
        const pageSize = parseInt(url.searchParams.get("pageSize") || "20");
        const includePrompts = url.searchParams.get("includePrompts") !== "false";
        const result = await handleListMemories(tag, page, pageSize, includePrompts);
        return this.jsonResponse(result);
      }

      if (path === "/api/memories" && method === "POST") {
        const body = (await req.json()) as any;
        const result = await handleAddMemory(body);
        return this.jsonResponse(result);
      }

      if (path.startsWith("/api/memories/") && method === "DELETE") {
        const parts = path.split("/");
        const id = parts[3];
        if (!id || id === "bulk-delete") {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const cascade = url.searchParams.get("cascade") === "true";
        const result = await handleDeleteMemory(id, cascade);
        return this.jsonResponse(result);
      }

      if (path.startsWith("/api/memories/") && method === "PUT") {
        const id = path.split("/").pop();
        if (!id) {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const body = (await req.json()) as any;
        const result = await handleUpdateMemory(id, body);
        return this.jsonResponse(result);
      }

      if (path === "/api/memories/bulk-delete" && method === "POST") {
        const body = (await req.json()) as any;
        const cascade = body.cascade !== false;
        const result = await handleBulkDelete(body.ids || [], cascade);
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

      if (path.match(/^\/api\/memories\/[^/]+\/pin$/) && method === "POST") {
        const id = path.split("/")[3];
        if (!id) {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const result = await handlePinMemory(id);
        return this.jsonResponse(result);
      }

      if (path.match(/^\/api\/memories\/[^/]+\/unpin$/) && method === "POST") {
        const id = path.split("/")[3];
        if (!id) {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const result = await handleUnpinMemory(id);
        return this.jsonResponse(result);
      }

      if (path === "/api/cleanup" && method === "POST") {
        const result = await handleRunCleanup();
        return this.jsonResponse(result);
      }

      if (path === "/api/deduplicate" && method === "POST") {
        const result = await handleRunDeduplication();
        return this.jsonResponse(result);
      }

      if (path === "/api/migration/detect" && method === "GET") {
        const result = await handleDetectMigration();
        return this.jsonResponse(result);
      }

      if (path === "/api/migration/tags/detect" && method === "GET") {
        const result = await handleDetectTagMigration();
        return this.jsonResponse(result);
      }

      if (path === "/api/migration/tags/run-batch" && method === "POST") {
        const body = (await req.json()) as any;
        const batchSize = body?.batchSize || 5;
        const result = await handleRunTagMigrationBatch(batchSize);
        return this.jsonResponse(result);
      }

      if (path === "/api/migration/tags/progress" && method === "GET") {
        const result = await handleGetTagMigrationProgress();
        return this.jsonResponse(result);
      }

      if (path === "/api/migration/run" && method === "POST") {
        const body = (await req.json()) as any;
        const strategy = body.strategy || "fresh-start";
        if (strategy !== "fresh-start" && strategy !== "re-embed") {
          return this.jsonResponse({ success: false, error: "Invalid strategy" });
        }
        const result = await handleRunMigration(strategy);
        return this.jsonResponse(result);
      }

      if (path.startsWith("/api/prompts/") && method === "DELETE") {
        const parts = path.split("/");
        const id = parts[3];
        if (!id || id === "bulk-delete") {
          return this.jsonResponse({ success: false, error: "Invalid ID" });
        }
        const cascade = url.searchParams.get("cascade") === "true";
        const result = await handleDeletePrompt(id, cascade);
        return this.jsonResponse(result);
      }

      if (path === "/api/prompts/bulk-delete" && method === "POST") {
        const body = (await req.json()) as any;
        const cascade = body.cascade !== false;
        const result = await handleBulkDeletePrompts(body.ids || [], cascade);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile" && method === "GET") {
        const userId = url.searchParams.get("userId") || undefined;
        const result = await handleGetUserProfile(userId);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile/changelog" && method === "GET") {
        const profileId = url.searchParams.get("profileId");
        const limit = parseInt(url.searchParams.get("limit") || "5");
        if (!profileId) {
          return this.jsonResponse({ success: false, error: "profileId parameter required" });
        }
        const result = await handleGetProfileChangelog(profileId, limit);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile/snapshot" && method === "GET") {
        const changelogId = url.searchParams.get("chlogId");
        if (!changelogId) {
          return this.jsonResponse({ success: false, error: "changelogId parameter required" });
        }
        const result = await handleGetProfileSnapshot(changelogId);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile/refresh" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const userId = body.userId || undefined;
        const result = await handleRefreshProfile(userId);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile/ai-cleanup" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const userId = body.userId || undefined;
        const includeIds = Array.isArray(body.includeIds)
          ? (body.includeIds as string[])
          : undefined;
        const result = await handleAICleanup(userId, includeIds);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile/ai-cleanup/apply" && method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const userId = body.userId || undefined;
        const result = await handleApplyCleanup(userId, body);
        return this.jsonResponse(result);
      }

      if (path === "/api/user-profile/item" && method === "PATCH") {
        const body = (await req.json().catch(() => ({}))) as any;
        const result = await handleUpdateProfileItem(body);
        return this.jsonResponse(result);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return this.jsonResponse(
        {
          success: false,
          error: String(error),
        },
        500
      );
    }
  }

  private serveStaticFile(filename: string, contentType: string): Response {
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

      let content = readFileSync(filePath, "utf-8");

      if (filename === "index.html") {
        const token = getOrCreateAuthToken();
        content = content.replace(
          "</head>",
          `<script>window.__OPENCODE_MEM_TOKEN__=${JSON.stringify(token)};</script></head>`
        );
      }

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

  private jsonResponse(data: any, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}

export async function startWebServer(config: WebServerConfig): Promise<WebServer> {
  const server = new WebServer(config);
  await server.start();
  return server;
}
