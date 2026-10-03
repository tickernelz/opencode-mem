//
// Runs the real performUserProfileLearning in an isolated Bun child process
// against the real cross-process learning lock (real coordination storage via
// CONFIG.storagePath). Only the provider/IO boundaries are mocked: the learning
// service, the lock module, and the profile utils are the real compiled
// sources. Driven by tests/profile-learning-service-lock.test.ts via a JSON
// config file path in argv[2]; call events are appended as single-line JSON to
// cfg.eventsFile so the parent can assert ordering across processes.
//
// Plain JavaScript on purpose: this file is executed by `bun <file>.mjs`, not
// imported by the test runner.
//
import { mock } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("usage: bun profile-learning-service-worker.mjs <config.json>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

function event(ev, data) {
  appendFileSync(cfg.eventsFile, JSON.stringify({ ev, data: data ?? null }) + "\n");
}

/** Handshake wait for a file the parent creates — never a fixed sleep. */
async function waitFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !existsSync(path)) {
    await sleep(20);
  }
  if (!existsSync(path)) throw new Error(`worker: handshake file never appeared: ${path}`);
}

const learningUrl = new URL("../../src/memory/user-memory-learning.js", import.meta.url).href;
const configUrl = new URL("../../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../../src/memory/tags.js", import.meta.url).href;
const loggerUrl = new URL("../../src/infra/logger.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../../src/memory/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const profileManagerUrl = new URL("../../src/user-profile/user-profile-manager.js", import.meta.url)
  .href;
const providerLoaderUrl = new URL("../../src/ai/opencode-provider-loader.js", import.meta.url).href;
const llmClientUrl = new URL("../../src/ai/profile-llm-client.js", import.meta.url).href;

const promptCount = cfg.promptCount ?? 10;
const prompts = Array.from({ length: promptCount }, (_, i) => ({
  id: `prompt-${i}`,
  sessionId: "session-1",
  messageId: `msg-${i}`,
  projectPath: cfg.projectPath ?? "/workspace",
  content: `Implement feature ${i} with tests`,
  createdAt: i + 1,
  captured: true,
  user_learning_captured: false,
  capture_attempts: 0,
}));

const marked = new Set();

mock.module(configUrl, () => ({
  CONFIG: {
    autoCaptureProviderStatus:
      cfg.providerReady === false
        ? { ready: false, issues: ["provider offline"] }
        : { ready: true, mode: "opencode", issues: [] },
    userProfileAnalysisInterval: cfg.threshold ?? 5,
    opencodeProvider: "opencode-mock",
    opencodeModel: "mock-model",
    showUserProfileToasts: false,
    userProfileValidationEnabled: false,
    storagePath: cfg.storagePath,
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

mock.module(tagsUrl, () => ({
  getTags: () => ({
    user: {
      tag: "opencode_user_test",
      displayName: "Test User",
      userName: "tester",
      userEmail: "test@example.com",
    },
  }),
}));

// Route every log line into the event stream: the "skipped (another process
// holds the learning lock)" label is how the parent proves the loser bounced
// off the lock rather than silently doing nothing.
mock.module(loggerUrl, () => ({
  log: (label, data) => event("log", { label, data }),
}));

mock.module(promptManagerUrl, () => ({
  userPromptManager: {
    countUnanalyzedForUserLearning: async () => {
      event("count");
      return prompts.filter((p) => !marked.has(p.id)).length;
    },
    getPromptsForUserLearning: async (n) => {
      event("select");
      if (cfg.selectEmpty) return [];
      return prompts.filter((p) => !marked.has(p.id)).slice(0, n);
    },
    markMultipleAsUserLearningCaptured: async (ids) => {
      event("mark", { ids: [...ids] });
      for (const id of ids) marked.add(id);
    },
  },
}));

mock.module(profileManagerUrl, () => ({
  userProfileManager: {
    getActiveProfile: async () => null,
    createProfile: async (userId) => {
      event("profile-write", { userId });
      return { id: "profile-1", userId };
    },
    mergeProfileData: async (_existing, incoming) => incoming,
    updateProfile: async () => true,
    decayInMemory: (d) => ({ data: d }),
    syncConfidence: () => {},
    getProfileById: async () => null,
    evolveAndUpdate: async () => {},
  },
}));

mock.module(providerLoaderUrl, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async () => {
      event("llm-entered");
      if (cfg.llmError) {
        event("llm-error");
        throw new Error("provider rejected: simulated refusal");
      }
      if (cfg.blockOnLlm) await waitFile(cfg.releaseFile);
      event("llm-exit");
      return {
        preferences: [
          {
            category: "style",
            description: "Prefers concise answers",
            confidence: 0.5,
            evidence: ["keep it short"],
          },
        ],
        patterns: [],
        workflows: [],
      };
    },
  }),
}));

mock.module(llmClientUrl, () => ({
  getOpenCodeClient: async () => ({}),
}));

const ctx = {};
const directory = cfg.projectPath ?? "/workspace";

async function runOnce() {
  const { performUserProfileLearning } = await import(learningUrl);
  await performUserProfileLearning(ctx, directory);
}

try {
  switch (cfg.scenario) {
    case "full":
    case "early":
    case "empty":
    case "not-ready":
      await runOnce();
      console.log(JSON.stringify({ ok: true }));
      break;
    case "llm-error": {
      let error = null;
      try {
        await runOnce();
      } catch (e) {
        error = e?.message ?? String(e);
      }
      console.log(JSON.stringify({ propagated: error !== null, error }));
      break;
    }
    case "inproc-race": {
      const { performUserProfileLearning } = await import(learningUrl);
      const runs = await Promise.allSettled([
        performUserProfileLearning(ctx, directory),
        performUserProfileLearning(ctx, directory),
      ]);
      console.log(JSON.stringify({ ok: true, statuses: runs.map((r) => r.status) }));
      break;
    }
    case "error-then-retry": {
      const { performUserProfileLearning } = await import(learningUrl);
      cfg.llmError = true; // first pass fails inside the LLM
      let firstError = null;
      try {
        await performUserProfileLearning(ctx, directory);
      } catch (e) {
        firstError = e?.message ?? String(e);
      }
      cfg.llmError = false; // second run in the same process must succeed
      await performUserProfileLearning(ctx, directory);
      console.log(JSON.stringify({ ok: true, firstError }));
      break;
    }
    default:
      throw new Error(`worker: unknown scenario ${cfg.scenario}`);
  }
} catch (e) {
  console.log(JSON.stringify({ fatal: e?.message ?? String(e) }));
  process.exit(1);
}
process.exit(0);
