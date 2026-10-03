import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { SharedRuntimeClient } from "../src/runtime/client.js";

describe("MCP server progressive tools", () => {
  it("exposes timeline → search → get progressive disclosure tools", async () => {
    const calls: string[] = [];
    const fakeClient: SharedRuntimeClient = {
      baseUrl: "http://127.0.0.1:9",
      directory: "/tmp",
      timeline: async (args) => {
        calls.push(`timeline:${args.limit ?? "default"}`);
        return {
          success: true,
          memories: [{ id: "1", createdAt: "2026-01-01T00:00:00.000Z", snippet: "recent" }],
          hint: "Call memory_get",
        };
      },
      search: async (args) => {
        calls.push(`search:${args.query}`);
        return {
          success: true,
          results: [{ id: "1", score: 88, snippet: "hi" }],
          hint: "Call memory_get with promising ids to fetch full content.",
        };
      },
      get: async (ids) => {
        calls.push(`get:${ids.join(",")}`);
        return { success: true, memories: [{ id: ids[0], content: "full" }] };
      },
      write: async (args) => {
        calls.push(`write:${args.action}`);
        return { success: true, message: "ok" };
      },
      executeTool: async () => ({ success: false, error: "not used by MCP stdio" }),
    };

    const { server } = await createMcpServer("/tmp", fakeClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual(["memory_get", "memory_search", "memory_timeline", "memory_write"]);

      const timeline = await client.callTool({
        name: "memory_timeline",
        arguments: { limit: 5 },
      });
      expect(JSON.stringify(timeline)).toContain("memory_get");
      expect(calls).toContain("timeline:5");

      const search = await client.callTool({
        name: "memory_search",
        arguments: { query: "auth" },
      });
      expect(JSON.stringify(search)).toContain("memory_get");
      expect(calls).toContain("search:auth");

      const get = await client.callTool({
        name: "memory_get",
        arguments: { ids: ["1"] },
      });
      expect(JSON.stringify(get)).toContain("full");
      expect(calls).toContain("get:1");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
