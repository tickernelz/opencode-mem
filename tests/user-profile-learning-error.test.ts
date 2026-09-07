import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

const learningUrl = new URL(
  "../src/services/user-memory-learning.js",
  import.meta.url
).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const profileManagerUrl = new URL(
  "../src/services/user-profile/user-profile-manager.js",
  import.meta.url
).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;
const profileLlmClientUrl = new URL(
  "../src/services/ai/profile-llm-client.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;

function runProviderFailureScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-error-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const prompts = Array.from({ length: 10 }, (_, i) => ({
  id: \`prompt-\${i}\`,
  sessionId: "session-1",
  messageId: \`msg-\${i}\`,
  projectPath: "/workspace",
  content: \`Implement feature \${i}\`,
  createdAt: i + 1,
  captured: false,
  user_learning_captured: false,
  capture_attempts: 0,
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    userProfileAnalysisInterval: 5,
    opencodeProvider: "opencode-go",
    opencodeModel: "deepseek-v4-flash",
    showUserProfileToasts: false,
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    user: {
      tag: "opencode_user_test",
      displayName: "Test User",
      userName: "tester",
      userEmail: "test@example.com",
    },
  }),
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    countUnanalyzedForUserLearning: async () => 10,
    getPromptsForUserLearning: async () => prompts,
    markMultipleAsUserLearningCaptured: async () => {},
  },
}));

mock.module(${JSON.stringify(profileManagerUrl)}, () => ({
  userProfileManager: {
    getActiveProfile: async () => null,
    createProfile: async () => ({}),
    mergeProfileData: async () => ({}),
    updateProfile: async () => true,
    decayInMemory: (d) => ({ data: d }),
    syncConfidence: () => {},
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async () => {
      throw new Error(
        "opencode-mem: opencode reported APIError: Thinking mode does not support this tool_choice"
      );
    },
  }),
}));

mock.module(${JSON.stringify(profileLlmClientUrl)}, () => ({
  getOpenCodeClient: async () => ({}),
}));

try {
  const { performUserProfileLearning } = await import(${JSON.stringify(learningUrl)});
  await performUserProfileLearning({}, "/workspace");
  console.log(JSON.stringify({ error: null }));
} catch (e) {
  console.log(JSON.stringify({ error: e?.message ?? String(e) }));
}
process.exit(0);
`;

  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{"));

  return {
    exitCode: result.exitCode,
    stderr,
    parsed: jsonLine ? JSON.parse(jsonLine) : null,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("user profile learning error propagation (#265)", () => {
  it("preserves the opencode provider error when no manual fallback is configured", () => {
    const result = runProviderFailureScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.error).toContain("Thinking mode does not support");
    expect(result.parsed?.error).not.toContain(
      "External API not configured"
    );
  });
});
