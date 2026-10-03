import { describe, expect, it } from "bun:test";
import { WebServer } from "../src/runtime/http/web-server.js";
import { AUTH_HEADER, getOrCreateAuthToken } from "../src/runtime/http/auth-token.js";
import {
  writeRuntimeInfo,
  clearRuntimeInfo,
  readRuntimeInfo,
} from "../src/runtime/http/runtime-info.js";

describe("standalone serve + MCP health", () => {
  it("health reports service identity and is discoverable", async () => {
    const port = 48742;
    const server = new WebServer({
      enabled: true,
      host: "127.0.0.1",
      port,
    });

    await server.start();
    writeRuntimeInfo({
      host: "127.0.0.1",
      port,
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
      startedAt: Date.now(),
    });

    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.ok).toBe(true);
      const body = (await health.json()) as {
        success: boolean;
        status: string;
        service?: string;
        pid?: number;
      };
      expect(body.success).toBe(true);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("opencode-mem");
      expect(body.pid).toBe(process.pid);

      const runtime = readRuntimeInfo();
      expect(runtime?.port).toBe(port);
      expect(runtime?.url).toBe(`http://127.0.0.1:${port}`);

      const runtimeHealth = await fetch(`${runtime!.url}/api/health`);
      expect(runtimeHealth.ok).toBe(true);

      const token = getOrCreateAuthToken();
      const badWrite = await fetch(`http://127.0.0.1:${port}/api/mcp/write`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTH_HEADER]: token,
        },
        body: JSON.stringify({}),
      });
      expect(badWrite.status).toBe(400);
      const badBody = (await badWrite.json()) as { success: boolean; error?: string };
      expect(badBody.success).toBe(false);
      expect(badBody.error).toContain("action");

      // Internal runtime tool endpoint (full plugin shapes) is mounted.
      const runtimeHelp = await fetch(`http://127.0.0.1:${port}/api/runtime/tool`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTH_HEADER]: token,
        },
        body: JSON.stringify({ mode: "help" }),
      });
      expect(runtimeHelp.ok).toBe(true);
      const helpBody = (await runtimeHelp.json()) as {
        success: boolean;
        commands?: unknown[];
      };
      expect(helpBody.success).toBe(true);
      expect(Array.isArray(helpBody.commands)).toBe(true);
    } finally {
      clearRuntimeInfo(process.pid);
      await server.stop();
    }
  });
});
