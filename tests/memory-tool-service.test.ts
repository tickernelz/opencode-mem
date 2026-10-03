import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runIsolated(scriptBody: string): { stdout: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-tool-svc-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  writeFileSync(scriptPath, scriptBody);
  const result = Bun.spawnSync(["bun", "test", scriptPath], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString() + result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("memory-tool-service", () => {
  it("executes help without warming embeddings", () => {
    const clientUrl = new URL("../src/memory/client.js", import.meta.url).href;
    const configUrl = new URL("../src/config.js", import.meta.url).href;
    const tagsUrl = new URL("../src/memory/tags.js", import.meta.url).href;
    const languageUrl = new URL("../src/infra/language-detector.js", import.meta.url).href;
    const serviceUrl = new URL("../src/memory/tool/index.js", import.meta.url).href;

    const { exitCode, stdout } = runIsolated(`
import { mock, expect, test } from "bun:test";

let warmupCalls = 0;
mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => { warmupCalls += 1; },
    ensureStorageReady: async () => {},
    getEmbeddingInitError: () => null,
  },
}));
mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { autoCaptureLanguage: "en", memory: { defaultScope: "project" } },
  isConfigured: () => true,
}));
mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    user: { userEmail: "u@example.com", displayName: "U", userName: "u" },
    project: { tag: "opencode_project_abc", displayName: "p" },
  }),
}));
mock.module(${JSON.stringify(languageUrl)}, () => ({
  getLanguageName: () => "English",
}));

test("help", async () => {
  const { executeMemoryTool } = await import(${JSON.stringify(serviceUrl)});
  const raw = await executeMemoryTool({ mode: "help" }, { directory: "/tmp" });
  const parsed = JSON.parse(raw);
  expect(parsed.success).toBe(true);
  expect(parsed.commands.length).toBeGreaterThan(3);
  expect(warmupCalls).toBe(0);
});
`);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("pass");
  });

  it("formats MCP search results as compact snippets", () => {
    const clientUrl = new URL("../src/memory/client.js", import.meta.url).href;
    const configUrl = new URL("../src/config.js", import.meta.url).href;
    const tagsUrl = new URL("../src/memory/tags.js", import.meta.url).href;
    const languageUrl = new URL("../src/infra/language-detector.js", import.meta.url).href;
    const privacyUrl = new URL("../src/infra/privacy.js", import.meta.url).href;
    const serviceUrl = new URL("../src/memory/tool/index.js", import.meta.url).href;

    const { exitCode, stdout } = runIsolated(`
import { mock, expect, test } from "bun:test";

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    ensureStorageReady: async () => {},
    getEmbeddingInitError: () => null,
    searchMemories: async () => ({
      success: true,
      results: [{ id: "mem_1", memory: "A".repeat(400), similarity: 0.91 }],
      total: 1,
      timing: 0,
    }),
  },
}));
mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { autoCaptureLanguage: "en", memory: { defaultScope: "project" } },
  isConfigured: () => true,
}));
mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    user: { userEmail: "u@example.com" },
    project: { tag: "opencode_project_abc" },
  }),
}));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));
mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (s) => s,
  isFullyPrivate: () => false,
}));

test("mcp search", async () => {
  const { mcpSearchMemories, MCP_SNIPPET_MAX_CHARS } = await import(${JSON.stringify(serviceUrl)});
  const result = await mcpSearchMemories({ query: "auth", limit: 5 }, { directory: "/tmp" });
  expect(result.success).toBe(true);
  expect(result.results[0].id).toBe("mem_1");
  expect(result.results[0].score).toBe(91);
  expect(result.results[0].snippet.length).toBeLessThanOrEqual(MCP_SNIPPET_MAX_CHARS);
  expect(result.hint).toContain("memory_get");
});
`);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("pass");
  });

  it("formats MCP timeline results as compact chronological snippets", () => {
    const clientUrl = new URL("../src/memory/client.js", import.meta.url).href;
    const configUrl = new URL("../src/config.js", import.meta.url).href;
    const tagsUrl = new URL("../src/memory/tags.js", import.meta.url).href;
    const languageUrl = new URL("../src/infra/language-detector.js", import.meta.url).href;
    const privacyUrl = new URL("../src/infra/privacy.js", import.meta.url).href;
    const serviceUrl = new URL("../src/memory/tool/index.js", import.meta.url).href;

    const { exitCode, stdout } = runIsolated(`
import { mock, expect, test } from "bun:test";

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    ensureStorageReady: async () => {},
    getEmbeddingInitError: () => null,
    listMemories: async () => ({
      success: true,
      memories: [
        {
          id: "mem_old",
          summary: "B".repeat(400),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  },
}));
mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { autoCaptureLanguage: "en", memory: { defaultScope: "project" } },
  isConfigured: () => true,
}));
mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    user: { userEmail: "u@example.com" },
    project: { tag: "opencode_project_abc" },
  }),
}));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));
mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (s) => s,
  isFullyPrivate: () => false,
}));

test("mcp timeline", async () => {
  const { mcpTimelineMemories, MCP_SNIPPET_MAX_CHARS } = await import(${JSON.stringify(serviceUrl)});
  const result = await mcpTimelineMemories({ limit: 5 }, { directory: "/tmp" });
  expect(result.success).toBe(true);
  expect(result.memories[0].id).toBe("mem_old");
  expect(result.memories[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
  expect(result.memories[0].snippet.length).toBeLessThanOrEqual(MCP_SNIPPET_MAX_CHARS);
  expect(result.hint).toContain("memory_get");
});
`);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("pass");
  });

  it("returns memories for MCP get", () => {
    const clientUrl = new URL("../src/memory/client.js", import.meta.url).href;
    const configUrl = new URL("../src/config.js", import.meta.url).href;
    const serviceUrl = new URL("../src/memory/tool/index.js", import.meta.url).href;

    const { exitCode, stdout } = runIsolated(`
import { mock, expect, test } from "bun:test";

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    ensureStorageReady: async () => {},
    getMemoriesByIds: async (ids) => ({
      success: true,
      memories: ids.map((id) => ({ id, content: \`body-\${id}\`, tags: [] })),
    }),
  },
}));
mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {},
  isConfigured: () => true,
}));

test("mcp get", async () => {
  const { mcpGetMemories } = await import(${JSON.stringify(serviceUrl)});
  const result = await mcpGetMemories(["a", "b"]);
  expect(result.success).toBe(true);
  expect(result.count).toBe(2);
  expect(result.memories.map((m) => m.id)).toEqual(["a", "b"]);
});
`);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("pass");
  });
});
