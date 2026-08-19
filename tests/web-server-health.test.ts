import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { WebServer, nextFallbackPort } from "../src/services/web-server.js";

describe("web server health check", () => {
  it("authenticates the stats request when an API token is configured", async () => {
    const originalFetch = globalThis.fetch;
    let requestHeaders: Headers | undefined;
    globalThis.fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(null, { status: 200 });
    };

    try {
      const server = new WebServer({
        enabled: true,
        host: "0.0.0.0",
        port: 4747,
        apiToken: "health-token",
      });

      expect(await server.checkServerAvailable()).toBe(true);
      expect(requestHeaders?.get("Authorization")).toBe("Bearer health-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the next port only after repeated failed takeovers", () => {
    expect(nextFallbackPort(4747, 0, 4757)).toBe(4747);
    expect(nextFallbackPort(4747, 2, 4757)).toBe(4747);
    expect(nextFallbackPort(4747, 3, 4757)).toBe(4748);
    expect(nextFallbackPort(4748, 3, 4757)).toBe(4749);
    expect(nextFallbackPort(4757, 3, 4757)).toBe(4757);
    expect(nextFallbackPort(4757, 99, 4757)).toBe(4757);
  });

  it("becomes owner on a neighbor port after repeated failed takeovers", async () => {
    // Simulate a Windows orphaned LISTEN socket: a real listener holds the
    // port and answers HTTP, but every bind attempt fails with EADDRINUSE.
    const occupy = createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupy.listen(48747, "127.0.0.1", resolve));

    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 48747 });
      let takeoverCallbacks = 0;
      server.setOnTakeoverCallback(async () => {
        takeoverCallbacks += 1;
      });
      // The port is held and non-responsive from the health checker's view,
      // so every takeover cycle must conclude the port is unavailable.
      server.checkServerAvailable = async () => false;

      const attemptTakeover = (
        server as unknown as { attemptTakeover(): Promise<void> }
      ).attemptTakeover.bind(server);

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(server.getUrl()).toBe("http://127.0.0.1:48747");

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(server.getUrl()).toBe("http://127.0.0.1:48747");

      await attemptTakeover();
      expect(server.isServerOwner()).toBe(true);
      expect(server.getUrl()).toBe("http://127.0.0.1:48748");
      expect(takeoverCallbacks).toBe(1);

      const response = await fetch(`${server.getUrl()}/api/health`);
      expect(response.status).toBe(200);

      await server.stop();
    } finally {
      Math.random = originalRandom;
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });
});
