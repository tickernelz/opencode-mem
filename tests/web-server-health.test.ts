import { describe, expect, it } from "bun:test";
import { WebServer } from "../src/services/web-server.js";

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
});
