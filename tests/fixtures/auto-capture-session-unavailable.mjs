import { mock } from "bun:test";
const u = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const scenario = JSON.parse(process.argv[2]);
const counters = {
  fetch: 0,
  summary: 0,
  persist: 0,
  failed: 0,
  released: 0,
  deleted: 0,
  delays: [],
};
const logs = [];
const { serializeError } = await import(u("services/logger"));
mock.module(u("services/logger"), () => ({
  log: (message, data) => logs.push({ message, ...data }),
  serializeError,
}));
mock.module(u("config"), () => ({
  CONFIG: {
    autoCaptureMaxRetries: 3,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai",
    opencodeModel: "test-model",
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));
mock.module(u("services/language-detector"), () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
const prompts = Array.from({ length: scenario.batch ? 2 : 1 }, (_, i) => ({
  id: `p${i}`,
  sessionId: "session",
  messageId: `u${i}`,
  content: `Fix bug ${i}`,
  captured: 0,
  capture_attempts: scenario.priorAttempts ?? 0,
  user_learning_captured: 0,
}));
if (scenario.otherSession)
  prompts.push({
    id: "other",
    sessionId: "other",
    messageId: "other-user",
    content: "Fix another bug",
    captured: 0,
    capture_attempts: 0,
    user_learning_captured: 0,
  });
mock.module(u("services/user-prompt/user-prompt-manager"), () => ({
  userPromptManager: {
    async getUncapturedPromptsForSession(sid) {
      return prompts.filter(
        (p) => p.sessionId === sid && p.captured === 0 && p.capture_attempts < 3
      );
    },
    async claimPrompt(id) {
      const p = prompts.find((p) => p.id === id);
      if (p.captured !== 0) return false;
      p.captured = 2;
      return true;
    },
    async releaseClaim(id) {
      counters.released++;
      const p = prompts.find((p) => p.id === id);
      if (p.captured === 2) p.captured = 0;
      return true;
    },
    async recordFailedAttempt(id) {
      counters.failed++;
      prompts.find((p) => p.id === id).capture_attempts++;
    },
    async deletePrompt() {
      counters.deleted++;
    },
    async linkMemoryToPrompt(id, memoryID) {
      prompts.find((p) => p.id === id).memoryID = memoryID;
    },
    async markAsCaptured(id) {
      prompts.find((p) => p.id === id).captured = 1;
    },
  },
}));
mock.module(u("services/tags"), () => ({ getTags: () => ({ project: { tag: "project" } }) }));
const missing = () =>
  scenario.tagged
    ? { _tag: "Session.NotFoundError", sessionID: "session" }
    : Object.assign(new Error(""), { name: "Session.NotFoundError" });
mock.module(u("services/client"), () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => {
      counters.persist++;
      if (scenario.phase === "persist") throw missing();
      return { success: true, id: `memory-${counters.persist}` };
    },
  },
}));
mock.module(u("services/ai/opencode-provider-loader"), () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async () => {
      counters.summary++;
      if (scenario.phase === "summary") throw missing();
      return { type: "discussion", summary: "Fixed verified bug", tags: [] };
    },
  }),
}));
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay === 2000 || delay === 4000) {
    counters.delays.push(delay);
    queueMicrotask(() => fn(...args));
    return 0;
  }
  return realTimeout(fn, delay, ...args);
};
let available = scenario.phase === "summary" || scenario.phase === "persist";
const ctx = {
  client: {
    session: {
      messages: async ({ path }) => {
        counters.fetch++;
        if (!available && path.id !== "other") {
          if (scenario.kind === "generic")
            throw Object.assign(new Error("Not found"), { name: "NotFoundError", status: 404 });
          if (scenario.kind === "forbidden")
            throw Object.assign(new Error("Forbidden"), { status: 403 });
          if (scenario.kind === "transient") {
            available = true;
            throw new Error("temporary connection failure");
          }
          if (scenario.response) return { error: missing() };
          throw missing();
        }
        return {
          data: prompts
            .filter((p) => p.sessionId === path.id)
            .flatMap((p) => [
              {
                info: { id: p.messageId, role: "user" },
                parts: [{ type: "text", text: p.content }],
              },
              {
                info: { id: `a-${p.id}`, role: "assistant" },
                parts: [{ type: "text", text: `Changed bug ${p.id} and verified result` }],
              },
            ]),
        };
      },
    },
  },
};
const { performAutoCapture } = await import("../../src/services/auto-capture.js");
await Promise.all([
  performAutoCapture(ctx, "session", "/synthetic-project"),
  ...(scenario.otherSession ? [performAutoCapture(ctx, "other", "/synthetic-project")] : []),
]);
const first = JSON.parse(JSON.stringify({ counters, prompts, logs }));
if (scenario.recover) {
  await performAutoCapture(ctx, "session", "/synthetic-project");
  available = true;
  await performAutoCapture(ctx, "session", "/synthetic-project");
  await performAutoCapture(ctx, "session", "/synthetic-project");
}
console.log(JSON.stringify({ first, counters, prompts, logs }));
