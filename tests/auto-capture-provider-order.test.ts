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

const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;
const providerConfigUrl = new URL("../src/services/ai/provider-config.js", import.meta.url).href;
const aiProviderFactoryUrl = new URL("../src/services/ai/ai-provider-factory.js", import.meta.url)
  .href;

function runOrderScenario(opts: {
  order: "opencode-first" | "external-first";
  failOpencode?: boolean;
  failExternal?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-provider-order-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const channelCalls = [];
const logs = [];

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    autoCaptureProviderOrder: ${JSON.stringify(opts.order)},
    opencodeProvider: "openai",
    opencodeModel: "gpt-test",
    memoryProvider: "openai-chat",
    memoryModel: "gpt-4o-mini",
    memoryApiUrl: "https://api.example.com/v1",
    memoryApiKey: "sk-test",
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (content) => ({ success: true, id: "mem-1", content }),
    close() {},
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    project: {
      tag: "opencode_project_test",
      displayName: "Test Project",
      userName: "Test User",
      userEmail: "test@example.com",
      projectPath: "/workspace",
      projectName: "workspace",
      gitRepoUrl: undefined,
    },
  }),
}));

const prompt = {
  id: "prompt-1",
  sessionId: "session-1",
  messageId: "msg-1",
  projectPath: "/workspace",
  content: "Fix the login bug",
  createdAt: 1,
  captured: false,
  claimed: false,
  capture_attempts: 0,
  providerId: "openai",
  modelId: "gpt-test",
};

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getCaptureEvidence: async () => null,
    getPendingCaptureSessions: async () => [],
    markCaptureEvidenceReady: async () => {},
    getLastUncapturedPrompt() { return prompt; },
    getUncapturedPromptsForSession() { return [prompt]; },
    claimPrompt() { return true; },
    releaseClaim() {},
    deletePrompt() {},
    markAsCaptured() {},
    linkMemoryToPrompt() {},
    recordFailedAttempt() {},
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: (message, data) => logs.push({ message, data }),
  safeLog: (message, data) => logs.push({ message, data }),
  serializeError: (error) => ({
    error: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
  }),
}));

mock.module(${JSON.stringify(languageUrl)}, () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async () => {
      channelCalls.push("opencode");
      if (${JSON.stringify(Boolean(opts.failOpencode))}) {
        throw new Error("opencode channel failed");
      }
      return { summary: "from-opencode", type: "bug-fix", tags: ["auth"] };
    },
  }),
}));

mock.module(${JSON.stringify(providerConfigUrl)}, () => ({
  buildMemoryProviderConfig: () => ({}),
}));

mock.module(${JSON.stringify(aiProviderFactoryUrl)}, () => ({
  AIProviderFactory: {
    createProvider: () => ({
      executeToolCall: async () => {
        channelCalls.push("external");
        if (${JSON.stringify(Boolean(opts.failExternal))}) {
          return { success: false, error: "external channel failed" };
        }
        return {
          success: true,
          data: { summary: "from-external", type: "bug-fix", tags: ["auth"] },
        };
      },
    }),
    cleanupExpiredSessions: async () => 0,
  },
}));

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture(
  {
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "Fix the login bug" }] },
            { info: { id: "assistant-1", role: "assistant" }, parts: [{ type: "text", text: "Fixed auth.ts" }] },
          ],
        }),
      },
      tui: { showToast: async () => ({}) },
    },
  },
  "session-1",
  "/workspace"
);

console.log(JSON.stringify({ channelCalls, logs: logs.map((l) => l.message) }));
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

describe("auto-capture provider order", () => {
  it("tries opencode first by default order", () => {
    const result = runOrderScenario({ order: "opencode-first" });
    expect(result.exitCode).toBe(0);
    expect(result.parsed.channelCalls).toEqual(["opencode"]);
  });

  it("tries external first when configured", () => {
    const result = runOrderScenario({ order: "external-first" });
    expect(result.exitCode).toBe(0);
    expect(result.parsed.channelCalls).toEqual(["external"]);
  });

  it("falls back from opencode to external", () => {
    const result = runOrderScenario({ order: "opencode-first", failOpencode: true });
    expect(result.exitCode).toBe(0);
    expect(result.parsed.channelCalls).toEqual(["opencode", "external"]);
    expect(result.parsed.logs.some((m: string) => m.includes("falling back to external API"))).toBe(
      true
    );
  });

  it("falls back from external to opencode", () => {
    const result = runOrderScenario({ order: "external-first", failExternal: true });
    expect(result.exitCode).toBe(0);
    expect(result.parsed.channelCalls).toEqual(["external", "opencode"]);
    expect(
      result.parsed.logs.some((m: string) => m.includes("falling back to opencode provider"))
    ).toBe(true);
  });
});
