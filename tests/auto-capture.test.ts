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

function runScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-auto-capture-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const prompts = [
  {
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    projectPath: "/workspace",
    content: "First request",
    createdAt: 1,
    captured: false,
    claimed: false,
    capture_attempts: 0,
  },
  {
    id: "prompt-2",
    sessionId: "session-1",
    messageId: "msg-2",
    projectPath: "/workspace",
    content: "Second request",
    createdAt: 2,
    captured: false,
    claimed: false,
    capture_attempts: 0,
  },
];
const addCalls = [];
const summaryPrompts = [];

function pendingForSession(sessionId) {
  return prompts
    .filter((prompt) => prompt.sessionId === sessionId && !prompt.captured && !prompt.claimed)
    .sort((a, b) => a.createdAt - b.createdAt);
}

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai",
    opencodeModel: "gpt-test",
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (content, _tag, metadata) => {
      addCalls.push({ content, metadata });
      return { success: true, id: \`mem-\${addCalls.length}\` };
    },
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

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getLastUncapturedPrompt(sessionId) {
      return [...pendingForSession(sessionId)].pop() ?? null;
    },
    getUncapturedPromptsForSession(sessionId) {
      return pendingForSession(sessionId);
    },
    claimPrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || prompt.captured || prompt.claimed) return false;
      prompt.claimed = true;
      return true;
    },
    recordFailedAttempt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.capture_attempts += 1;
    },
    releaseClaim(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || !prompt.claimed || prompt.captured) return false;
      prompt.claimed = false;
      return true;
    },
    linkMemoryToPrompt(id, memoryId) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.linkedMemoryId = memoryId;
    },
    markAsCaptured(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
      }
    },
    deletePrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
        prompt.deleted = true;
      }
    },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    isProviderConnected: () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      summaryPrompts.push(userPrompt);
      return {
        summary: userPrompt.includes("First request") ? "summary-first" : "summary-second",
        type: "discussion",
        tags: [],
      };
    },
  }),
}));

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture(
  {
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "First request" }] },
            { info: { id: "assistant-1", role: "assistant" }, parts: [{ type: "text", text: "First response" }] },
            { info: { id: "msg-2", role: "user" }, parts: [{ type: "text", text: "Second request" }] },
            { info: { id: "assistant-2", role: "assistant" }, parts: [{ type: "text", text: "Second response" }] },
          ],
        }),
      },
      tui: { showToast: async () => ({}) },
    },
  },
  "session-1",
  "/workspace"
);

console.log(
  JSON.stringify({
    addPromptIds: addCalls.map((call) => call.metadata.promptId),
    summaries: addCalls.map((call) => call.content),
    summaryPrompts,
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

describe("auto-capture idle processing", () => {
  it("captures all uncaptured prompts in a session in chronological response windows", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.addPromptIds).toEqual(["prompt-1", "prompt-2"]);
    expect(result.parsed?.summaries).toEqual(["summary-first", "summary-second"]);
    expect(result.parsed?.summaryPrompts[0]).toContain("First response");
    expect(result.parsed?.summaryPrompts[0]).not.toContain("Second response");
    expect(result.parsed?.summaryPrompts[1]).toContain("Second response");
  });
});
