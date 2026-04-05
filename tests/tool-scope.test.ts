import { describe, expect, it, mock } from "bun:test";

const searchMemories = mock(async () => ({ success: true, results: [], total: 0, timing: 0 }));
let lastListScope: string | undefined;
const listMemories = mock(async (_tag?: string, _limit?: number, scope: string = "project") => {
  lastListScope = scope;
  return {
    success: true,
    memories: [],
    pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
    scope,
  };
});
let defaultScope: "project" | "all-projects" | undefined = "all-projects";

mock.module("../src/services/client.js", () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    searchMemories,
    listMemories,
    addMemory: async () => ({ success: true, id: "m1" }),
    deleteMemory: async () => ({ success: true }),
    searchMemoriesBySessionID: async () => ({ success: true, results: [], total: 0, timing: 0 }),
    close() {},
  },
}));

mock.module("../src/config.js", () => ({
  CONFIG: {
    autoCaptureLanguage: "auto",
    memory: {
      get defaultScope() {
        return defaultScope;
      },
    },
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

mock.module("../src/services/tags.js", () => ({
  getTags: () => ({ project: { tag: "project-tag" }, user: { userEmail: "u@example.com" } }),
}));

mock.module("../src/services/context.js", () => ({ formatContextForPrompt: () => "" }));
mock.module("../src/services/privacy.js", () => ({
  stripPrivateContent: (x: string) => x,
  isFullyPrivate: () => false,
}));
mock.module("../src/services/auto-capture.js", () => ({ performAutoCapture: async () => {} }));
mock.module("../src/services/user-memory-learning.js", () => ({
  performUserProfileLearning: async () => {},
}));
mock.module("../src/services/user-prompt/user-prompt-manager.js", () => ({
  userPromptManager: { savePrompt() {} },
}));
mock.module("../src/services/web-server.js", () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module("../src/services/logger.js", () => ({ log: () => {} }));
mock.module("../src/services/language-detector.js", () => ({ getLanguageName: () => "English" }));

const { OpenCodeMemPlugin } = await import("../src/index.js");

const ctx = { directory: "/workspace", client: {} } as unknown as Parameters<
  typeof OpenCodeMemPlugin
>[0];
const plugin = await OpenCodeMemPlugin(ctx);
const memoryTool = plugin.tool?.memory;

if (!memoryTool) {
  throw new Error("memory tool not available");
}

describe("tool memory scope", () => {
  it("falls back to config default scope", async () => {
    if (!memoryTool) throw new Error("memory tool not available");
    await memoryTool.execute({ mode: "search", query: "hello" }, { sessionID: "s1" } as never);
    const searchCall = searchMemories.mock.calls as unknown as Array<[string, string, string]>;
    expect(searchCall[0]?.[2]).toBe("all-projects");
  });

  it("lets explicit args scope override config", async () => {
    if (!memoryTool) throw new Error("memory tool not available");
    await memoryTool.execute({ mode: "list", scope: "project" }, { sessionID: "s1" } as never);
    const listCall = listMemories.mock.calls as unknown as Array<[string, number, string]>;
    expect(listCall[0]?.[2]).toBe("project");
  });

  it("falls back to project when config scope is unset", async () => {
    if (!memoryTool) throw new Error("memory tool not available");
    defaultScope = undefined;
    await memoryTool.execute({ mode: "list" }, { sessionID: "s1" } as never);
    expect(lastListScope).toBe("project");
    defaultScope = "all-projects";
  });
});
