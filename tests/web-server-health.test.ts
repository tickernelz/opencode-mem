import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { WebServer, nextFallbackPort } from "../src/services/web-server.js";

describe("web server health check", () => {
  it("authenticates the stats request when an API token is configured", async () => {
    const originalFetch = globalThis.fetch;
    let requestHeaders: Headers | undefined;
    globalThis.fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
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

  it("does not treat a 2xx from an unrelated service as an opencode-mem owner", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, status: "degraded" }), { status: 200 });

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 4747 });
      expect(await server.checkServerAvailable()).toBe(false);

      globalThis.fetch = async () =>
        new Response("<!doctype html><h1>elsewhere</h1>", { status: 200 });
      expect(await server.checkServerAvailable()).toBe(false);
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

  it("resets the takeover failure counter when the owner recovers", async () => {
    // Port held by a non-responsive listener so every bind fails.
    const occupy = createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupy.listen(48747, "127.0.0.1", resolve));

    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 48747 });
      // fail, fail, owner recovers, owner dies again
      const availability = [false, false, true, false];
      server.checkServerAvailable = async () => availability.shift() ?? false;

      const attemptTakeover = (
        server as unknown as { attemptTakeover(): Promise<void> }
      ).attemptTakeover.bind(server);

      await attemptTakeover();
      await attemptTakeover();
      expect(server.getUrl()).toBe("http://127.0.0.1:48747");

      // Owner recovers: counter resets, we stay a passive non-owner.
      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);

      // Owner dies again: the next single failure must NOT bump the port,
      // because the stale count (2) was reset on recovery.
      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(server.getUrl()).toBe("http://127.0.0.1:48747");

      await server.stop();
    } finally {
      Math.random = originalRandom;
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });

  it("enters a terminal state when every candidate port is unavailable", async () => {
    const occupy = createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupy.listen(48747, "127.0.0.1", resolve));

    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
      const server = new WebServer({ enabled: true, host: "127.0.0.1", port: 48747 });
      let exhaustedSignals = 0;
      server.setOnPortsExhaustedCallback(() => {
        exhaustedSignals += 1;
      });
      server.checkServerAvailable = async () => false;
      // Collapse the candidate range to the original port so one attempt exhausts it.
      (server as unknown as { maxFallbackPort: number }).maxFallbackPort = 48747;

      const attemptTakeover = (
        server as unknown as { attemptTakeover(): Promise<void> }
      ).attemptTakeover.bind(server);

      // First failure hits EADDRINUSE and arms the health loop.
      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(
        (server as unknown as { healthCheckInterval: NodeJS.Timeout | null }).healthCheckInterval
      ).not.toBe(null);

      await attemptTakeover();

      // Third consecutive failure at the last candidate: terminal, loop stopped, one signal.
      await attemptTakeover();
      expect(server.isServerOwner()).toBe(false);
      expect(exhaustedSignals).toBe(1);
      expect(
        (server as unknown as { healthCheckInterval: NodeJS.Timeout | null }).healthCheckInterval
      ).toBe(null);

      // No repeated signals on later attempts.
      await attemptTakeover();
      expect(exhaustedSignals).toBe(1);

      await server.stop();
    } finally {
      Math.random = originalRandom;
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });
});
