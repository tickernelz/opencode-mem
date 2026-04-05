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

const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const contextUrl = new URL("../src/services/context.js", import.meta.url).href;
const privacyUrl = new URL("../src/services/privacy.js", import.meta.url).href;
const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const learningUrl = new URL("../src/services/user-memory-learning.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const webServerUrl = new URL("../src/services/web-server.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;

type ScenarioInput = {
  defaultScope?: "project" | "all-projects";
  args: Record<string, unknown>;
};

function runScenario(input: ScenarioInput) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-tool-scope-"));
  tempDirs.push(dir);

  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const searchCalls = [];
let lastListScope;
const defaultScope = ${JSON.stringify(input.defaultScope)};

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    searchMemories: async (...args) => {
      searchCalls.push(args);
      return { success: true, results: [], total: 0, timing: 0 };
    },
    listMemories: async (_tag, _limit, scope = "project") => {
      lastListScope = scope;
      return {
        success: true,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        scope,
      };
    },
    addMemory: async () => ({ success: true, id: "m1" }),
    deleteMemory: async () => ({ success: true }),
    searchMemoriesBySessionID: async () => ({ success: true, results: [], total: 0, timing: 0 }),
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureLanguage: "auto",
    memory: { defaultScope },
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({ project: { tag: "project-tag" }, user: { userEmail: "u@example.com" } }),
}));

mock.module(${JSON.stringify(contextUrl)}, () => ({ formatContextForPrompt: () => "" }));
mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (value) => value,
  isFullyPrivate: () => false,
}));
mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({ performAutoCapture: async () => {} }));
mock.module(${JSON.stringify(learningUrl)}, () => ({ performUserProfileLearning: async () => {} }));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({ userPromptManager: { savePrompt() {} } }));
mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({ directory: "/workspace", client: {} });
const memoryTool = plugin.tool?.memory;

if (!memoryTool) {
  throw new Error("memory tool not available");
}

await memoryTool.execute(${JSON.stringify(input.args)}, { sessionID: "s1" });

console.log(
  JSON.stringify({
    searchScope: searchCalls[0]?.[2],
    listScope: lastListScope,
  })
);
`;

  writeFileSync(scriptPath, script);

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("tool memory scope", () => {
  it("falls back to config default scope", () => {
    const result = runScenario({
      defaultScope: "all-projects",
      args: { mode: "search", query: "hello" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.searchScope).toBe("all-projects");
  });

  it("lets explicit args scope override config", () => {
    const result = runScenario({
      defaultScope: "all-projects",
      args: { mode: "list", scope: "project" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.listScope).toBe("project");
  });

  it("falls back to project when config scope is unset", () => {
    const result = runScenario({
      args: { mode: "list" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.listScope).toBe("project");
  });
});
