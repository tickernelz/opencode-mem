import { describe, expect, it } from "bun:test";
import {
  normalizePlatformSource,
  resolvePlatformSource,
  platformSourceFromMetadata,
  PLATFORM_SOURCE_ENV,
} from "../src/shared/platform-source.js";
import { detectInstalledHosts } from "../src/cli/install.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setSharedRuntimeBridge,
  getSharedRuntimeBridge,
  isUsingSharedRuntime,
} from "../src/runtime/bridge.js";
import { executeMemoryTool } from "../src/memory/tool/index.js";

describe("platformSource", () => {
  it("normalizes and resolves env / explicit values", () => {
    expect(normalizePlatformSource("Cursor")).toBe("cursor");
    expect(normalizePlatformSource("weird host!!")).toBe("weird-host");
    const prev = process.env[PLATFORM_SOURCE_ENV];
    process.env[PLATFORM_SOURCE_ENV] = "claude";
    try {
      expect(resolvePlatformSource()).toBe("claude");
      expect(resolvePlatformSource("opencode")).toBe("opencode");
    } finally {
      if (prev === undefined) delete process.env[PLATFORM_SOURCE_ENV];
      else process.env[PLATFORM_SOURCE_ENV] = prev;
    }
    expect(platformSourceFromMetadata({ platformSource: "web" })).toBe("web");
  });
});

describe("detectInstalledHosts", () => {
  it("finds hosts from home layout", () => {
    const home = mkdtempSync(join(tmpdir(), "opencode-mem-ide-detect-"));
    try {
      mkdirSync(join(home, ".cursor"));
      mkdirSync(join(home, ".codex"));
      mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
      mkdirSync(join(home, ".kimi-code"));
      writeFileSync(join(home, ".claude.json"), "{}");
      const found = detectInstalledHosts(home);
      expect(found).toContain("cursor");
      expect(found).toContain("codex");
      expect(found).toContain("claude");
      expect(found).toContain("windsurf");
      expect(found).toContain("kimi");
      expect(found).not.toContain("gemini");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("shared runtime bridge", () => {
  it("routes add/search through full executeTool shapes when set", async () => {
    const calls: string[] = [];
    setSharedRuntimeBridge({
      baseUrl: "http://127.0.0.1:9",
      directory: "/tmp",
      search: async () => ({ success: true, results: [], hint: "memory_get" }),
      timeline: async () => ({ success: true, memories: [], hint: "memory_get" }),
      get: async () => ({ success: true, memories: [] }),
      write: async () => ({ success: true, id: "mem_bridge" }),
      executeTool: async ({ mode, query, platformSource }) => {
        calls.push(`tool:${mode}:${query ?? ""}:${platformSource ?? ""}`);
        if (mode === "search") {
          return {
            success: true,
            query,
            count: 1,
            results: [{ id: "1", content: "full hello", similarity: 90 }],
          };
        }
        if (mode === "add") {
          return { success: true, id: "mem_bridge", platformSource };
        }
        return { success: true };
      },
    });

    try {
      expect(isUsingSharedRuntime()).toBe(true);
      const add = JSON.parse(
        await executeMemoryTool(
          { mode: "add", content: "hello from bridge" },
          { directory: "/tmp", platformSource: "opencode" }
        )
      );
      expect(add.success).toBe(true);
      expect(calls).toContain("tool:add::opencode");

      const search = JSON.parse(
        await executeMemoryTool(
          { mode: "search", query: "hello" },
          { directory: "/tmp", platformSource: "opencode" }
        )
      );
      expect(search.success).toBe(true);
      expect(search.results?.[0]?.content).toBe("full hello");
      expect(search.results?.[0]?.similarity).toBe(90);
      expect(calls).toContain("tool:search:hello:opencode");
      expect(getSharedRuntimeBridge()?.baseUrl).toBe("http://127.0.0.1:9");
    } finally {
      setSharedRuntimeBridge(null);
      expect(isUsingSharedRuntime()).toBe(false);
    }
  });
});
