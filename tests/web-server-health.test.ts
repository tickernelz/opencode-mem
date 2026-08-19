import { describe, expect, it } from "bun:test";
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
});
