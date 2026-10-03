//
// Storage-error worker for tests/profile-learning-storage-error.test.ts.
//
// Runs the REAL performUserProfileLearning in an isolated Bun child process
// against the REAL cross-process learning lock (real coordination DB via
// CONFIG.storagePath in a temp dir). Only external boundaries are mocked:
// the LLM providers (native opencode + external AIProviderFactory) and the
// profile manager. The learning service, the lock module, and the lock's
// SQL are the real compiled sources.
//
// Driven by a JSON config path in argv[2]; events are appended as
// single-line JSON to cfg.eventsFile so the parent can assert exact call
// counts (externalCalls/update/mark) across processes.
//
// Plain JavaScript on purpose: executed by `bun <file>.mjs`, not imported
// by the test runner.
//
import { mock } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("usage: bun profile-learning-storage-error-worker.mjs <config.json>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

function event(ev, data) {
  appendFileSync(cfg.eventsFile, JSON.stringify({ ev, data: data ?? null }) + "\n");
}

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
const providerFactoryUrl = new URL("../../src/ai/ai-provider-factory.js", import.meta.url).href;
const providerConfigUrl = new URL("../../src/ai/provider-config.js", import.meta.url).href;

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

// A well-formed stored profile: every consumer between lock acquisition and
// analyzeUserProfile's merge (decay, category summary, change summary)
// JSON.parses profileData, so it must be valid with the three arrays.
const VALID_STORED_PROFILE = {
  id: "stored-profile-1",
  userId: "test@example.com",
  profileData: JSON.stringify({
    preferences: [
      {
        category: "style",
        description: "Prefers concise answers",
        confidence: 0.7,
        evidence: ["keep it short"],
      },
    ],
    patterns: [],
    workflows: [],
  }),
  totalPromptsAnalyzed: 5,
};

mock.module(configUrl, () => ({
  CONFIG: {
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    userProfileAnalysisInterval: cfg.threshold ?? 5,
    opencodeProvider: "opencode-mock",
    opencodeModel: "mock-model",
    showUserProfileToasts: false,
    userProfileValidationEnabled: false,
    // external fallback configured so the fallback path is REACHABLE — the
    // point of these scenarios is that storage errors must NOT reach it.
    memoryModel: "external-mock",
    memoryApiUrl: "https://external.invalid/v1",
    memoryProvider: "openai-chat",
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
      return prompts.filter((p) => !marked.has(p.id)).slice(0, n);
    },
    markMultipleAsUserLearningCaptured: async (ids) => {
      event("mark", { ids: [...ids] });
      for (const id of ids) marked.add(id);
    },
  },
}));

const PROFILE_READ_ERROR = new Error("storage read failed: simulated cold DB fault");
const PROFILE_MERGE_ERROR = new Error("storage merge failed: simulated cold DB fault");

mock.module(profileManagerUrl, () => ({
  userProfileManager: {
    getActiveProfile: async () => {
      event("get-active-profile");
      if (cfg.getProfileError) throw PROFILE_READ_ERROR;
      if (cfg.existingProfile === false) return null;
      if (cfg.corruptProfileData) {
        return { ...VALID_STORED_PROFILE, profileData: "{not valid json" };
      }
      return VALID_STORED_PROFILE;
    },
    createProfile: async (userId) => {
      event("profile-write", { userId });
      return { id: "profile-1", userId };
    },
    mergeProfileData: async (...args) => {
      event("merge");
      if (cfg.mergeError) throw PROFILE_MERGE_ERROR;
      return args[1];
    },
    updateProfile: async (profileId, data, promptCountArg, summary) => {
      event("update", { profileId, promptCount: promptCountArg, summary });
      return true;
    },
    decayInMemory: (d) => ({ data: d }),
    syncConfidence: () => {},
    getProfileById: async () => null,
    evolveAndUpdate: async () => {},
  },
}));

mock.module(providerLoaderUrl, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async () => {
      event("native-llm");
      if (cfg.nativeError) {
        event("native-llm-error");
        throw new Error("provider rejected: simulated native refusal");
      }
      if (cfg.blockOnLlm) await waitFile(cfg.releaseFile);
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

// External fallback boundary: if the production bug were still present, a
// storage error would be misread as a provider fault and land HERE.
mock.module(providerFactoryUrl, () => ({
  AIProviderFactory: {
    createProvider: () => ({
      executeToolCall: async () => {
        event("external-llm");
        if (cfg.externalError) {
          return { success: false, error: "external provider failed" };
        }
        return {
          success: true,
          data: {
            preferences: [
              {
                category: "style",
                description: "Prefers verbose answers",
                confidence: 0.5,
                evidence: ["explain more"],
              },
            ],
            patterns: [],
            workflows: [],
          },
        };
      },
    }),
  },
}));

mock.module(providerConfigUrl, () => ({
  buildMemoryProviderConfig: () => ({}),
}));

const ctx = {};
const directory = cfg.projectPath ?? "/workspace";

function eventsOf(list, ev) {
  return list.filter((e) => e.ev === ev);
}

async function collectEvents() {
  if (!existsSync(cfg.eventsFile)) return [];
  return readFileSync(cfg.eventsFile, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

try {
  const { performUserProfileLearning } = await import(learningUrl);
  const { tryAcquireProfileLearningLock } = await import("../../src/user-profile/learning-lock.js");

  let error = null;
  try {
    await performUserProfileLearning(ctx, directory);
  } catch (e) {
    error = e?.message ?? String(e);
  }

  const events = await collectEvents();

  if (cfg.holdLockFirst) {
    // Prove the release completed: after performUserProfileLearning returns
    // (or throws), the coordination lock must be acquirable again, and a
    // second run in the SAME process must be allowed to proceed.
    const release = await tryAcquireProfileLearningLock(directory);
    const reacquired = release !== null;
    if (release) await release();
    let secondRunError = null;
    try {
      cfg.mergeError = false;
      cfg.getProfileError = false;
      cfg.nativeError = false;
      await performUserProfileLearning(ctx, directory);
    } catch (e) {
      secondRunError = e?.message ?? String(e);
    }
    const after = await collectEvents();
    console.log(
      JSON.stringify({
        error,
        reacquired,
        secondRunError,
        externalCalls: eventsOf(events, "external-llm").length,
        updates: eventsOf(events, "update").length,
        marks: eventsOf(events, "mark").length,
        merges: eventsOf(events, "merge").length,
        nativeCalls: eventsOf(events, "native-llm").length,
        secondRunMarks: eventsOf(after, "mark").length - eventsOf(events, "mark").length,
      })
    );
  } else {
    console.log(
      JSON.stringify({
        error,
        externalCalls: eventsOf(events, "external-llm").length,
        updates: eventsOf(events, "update").length,
        marks: eventsOf(events, "mark").length,
        merges: eventsOf(events, "merge").length,
        nativeCalls: eventsOf(events, "native-llm").length,
      })
    );
  }
} catch (e) {
  console.log(JSON.stringify({ fatal: e?.message ?? String(e) }));
  process.exit(1);
}
process.exit(0);
