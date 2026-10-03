import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression coverage for the profile-learning output language. The structured-output
// call is mocked and only records the system prompt it would have been sent, so we
// can assert which language the model is instructed to write in.

const tempDirs: string[] = [];

const learningUrl = new URL("../src/memory/user-memory-learning.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/memory/tags.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/memory/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const profileManagerUrl = new URL("../src/user-profile/user-profile-manager.js", import.meta.url)
  .href;
const opencodeProviderLoaderUrl = new URL("../src/ai/opencode-provider-loader.js", import.meta.url)
  .href;
const profileLlmClientUrl = new URL("../src/ai/profile-llm-client.js", import.meta.url).href;
const loggerUrl = new URL("../src/infra/logger.js", import.meta.url).href;

const SHORT_SPANISH_PROMPTS = [
  "Corrige el error en la función de login",
  "Añade pruebas para el servicio de usuarios",
  "Explica por qué falla la compilación",
  "Refactoriza el módulo de pagos",
  "Revisa los cambios de esta rama",
];

const SHORT_ENGLISH_PROMPTS = [
  "Fix the bug in the login function",
  "Add tests for the user service",
  "Explain why the build is failing",
  "Refactor the payments module",
  "Review the changes on this branch",
];

function runLanguageScenario(autoCaptureLanguage: string | undefined, promptTexts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-lang-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const promptTexts = ${JSON.stringify(promptTexts)};
const prompts = promptTexts.map((content, i) => ({
  id: \`prompt-\${i}\`,
  sessionId: "session-1",
  messageId: \`msg-\${i}\`,
  projectPath: "/workspace",
  content,
  createdAt: i + 1,
  captured: false,
  user_learning_captured: false,
  capture_attempts: 0,
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    userProfileAnalysisInterval: prompts.length,
    opencodeProvider: "test-provider",
    opencodeModel: "test-model",
    showUserProfileToasts: false,
    autoCaptureLanguage: ${JSON.stringify(autoCaptureLanguage)},
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
    countUnanalyzedForUserLearning: async () => prompts.length,
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

let capturedSystemPrompt = null;
let capturedUserPrompt = null;

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async ({ systemPrompt, userPrompt }) => {
      capturedSystemPrompt = systemPrompt;
      capturedUserPrompt = userPrompt;
      return { preferences: [], patterns: [], workflows: [] };
    },
  }),
}));

mock.module(${JSON.stringify(profileLlmClientUrl)}, () => ({
  getOpenCodeClient: async () => ({}),
}));

try {
  const { performUserProfileLearning } = await import(${JSON.stringify(learningUrl)});
  await performUserProfileLearning({}, "/workspace");
  console.log(JSON.stringify({ error: null, systemPrompt: capturedSystemPrompt, userPrompt: capturedUserPrompt }));
} catch (e) {
  console.log(JSON.stringify({ error: e?.message ?? String(e), systemPrompt: capturedSystemPrompt, userPrompt: capturedUserPrompt }));
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
    parsed: jsonLine
      ? (JSON.parse(jsonLine) as {
          error: string | null;
          systemPrompt: string | null;
          userPrompt: string | null;
        })
      : null,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("user profile learning output language", () => {
  it("auto: detects short non-English prompts despite the English analysis scaffold", () => {
    const result = runLanguageScenario("auto", SHORT_SPANISH_PROMPTS);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.error).toBeNull();
    // Sanity check: the context sent to the LLM really is wrapped in the English scaffold.
    expect(result.parsed?.userPrompt).toContain("# User Profile Analysis");
    expect(result.parsed?.systemPrompt).toContain("text in Spanish.");
  });

  it("unset language behaves like auto", () => {
    const result = runLanguageScenario(undefined, SHORT_SPANISH_PROMPTS);

    expect(result.parsed?.error).toBeNull();
    expect(result.parsed?.systemPrompt).toContain("text in Spanish.");
  });

  it("auto: English prompts resolve to English", () => {
    const result = runLanguageScenario("auto", SHORT_ENGLISH_PROMPTS);

    expect(result.parsed?.error).toBeNull();
    expect(result.parsed?.systemPrompt).toContain("text in English.");
  });

  it("configured language overrides the language of the prompts", () => {
    const result = runLanguageScenario("en", SHORT_SPANISH_PROMPTS);

    expect(result.parsed?.error).toBeNull();
    expect(result.parsed?.systemPrompt).toContain("text in English.");
  });
});
