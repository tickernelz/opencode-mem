import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const u = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const scenario = JSON.parse(process.argv[2] ?? "{}");
const dir = mkdtempSync(join(tmpdir(), "capture-evidence-recovery-"));
const project = join(dir, "project");
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.HOME = dir;
process.env.USERPROFILE = dir;
const { cleanupTursoTestDirectory } = await import("../turso-test-utils.js");
const { CONFIG } = await import(u("config"));
Object.assign(CONFIG, {
  storagePath: dir,
  autoCaptureMaxRetries: 3,
  autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
  autoCaptureLanguage: "en",
  opencodeProvider: "openai",
  opencodeModel: "test-model",
  showAutoCaptureToasts: false,
  showErrorToasts: false,
  updateOnCaptureEnabled: false,
  autoCaptureEnabled: true,
  autoUpdate: { enabled: false },
  webServerEnabled: false,
  chatMessage: { enabled: false },
  compaction: { enabled: false },
  userProfileAnalysis: { enabled: false },
});
mock.module(u("config"), () => ({ CONFIG, initConfig: () => {}, isConfigured: () => true }));
const counters = { fetch: 0, summary: 0, persist: 0 };
const logs = [],
  summaryInputs = [];
const logger = { ...(await import(u("services/logger"))) };
mock.module(u("services/logger"), () => ({
  ...logger,
  log: (message, data) => logs.push({ message, ...data }),
  safeLog: () => {},
}));
mock.module(u("services/language-detector"), () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(u("services/tags"), () => ({
  getTags: () => ({ project: { tag: "synthetic-project" } }),
}));
mock.module(u("services/client"), () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    close: async () => {},
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => {
      counters.persist++;
      return { success: true, id: `memory-${counters.persist}` };
    },
  },
}));
mock.module(u("services/ai/opencode-provider-loader"), () => ({
  loadOpencodeProvider: async () => ({
    resetHostFetch: () => {},
    setHostFetch: () => {},
    setV2Client: () => {},
    createV2Client: () => ({}),
    setStructuredOutputTimeoutConfig: () => {},
    setConnectedProvidersRefresher: () => {},
    clearConnectedProvidersRefresher: () => {},
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async (input) => {
      counters.summary++;
      summaryInputs.push(input.userPrompt);
      return { type: "discussion", summary: "Observed synthetic tested fix", tags: [] };
    },
  }),
}));
const { userPromptManager: mgr } = await import(u("services/user-prompt/user-prompt-manager"));
const { tursoConnectionManager } = await import(u("services/turso/connection-manager"));

mock.module(u("services/auto-update"), () => ({ startAutoUpdate: () => {} }));
mock.module(u("services/web-server"), () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(u("services/cleanup-service"), () => ({
  cleanupService: { shouldRunCleanup: async () => false, runCleanup: async () => {} },
}));
const armed = [];
const realTimeout = globalThis.setTimeout,
  realClear = globalThis.clearTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  const handle = realTimeout(fn, delay, ...args);
  if (delay === 10000) armed.push({ handle, fn });
  return handle;
};
globalThis.clearTimeout = (handle) => {
  const i = armed.findIndex((t) => t.handle === handle);
  if (i !== -1) armed.splice(i, 1);
  return realClear(handle);
};
const fire = async () => {
  for (const t of armed.splice(0)) {
    realClear(t.handle);
    await t.fn();
  }
};
const { OpenCodeMemPlugin } = await import(u("index"));
const { awaitCaptureDrain } = await import(u("services/auto-capture"));
let gone = false;
let hostGets = 0;
const ctx = {
  directory: project,
  client: {
    session: {
      get: async () => {
        hostGets++;
        if (gone) throw { name: "Session.NotFoundError" };
        return { data: { title: "synthetic ordinary work" } };
      },
      messages: async () => {
        counters.fetch++;
        throw { name: "Session.NotFoundError" };
      },
    },
    tui: { showToast: async () => ({}) },
  },
};
let plugin = await OpenCodeMemPlugin(ctx);
const emit = (type, properties) => plugin.event({ event: { type, properties } });
const id = await mgr.savePrompt("s", "u", project, "Fix synthetic regression");
let armedCount,
  savedBefore,
  getsBeforeRestart = 0;
try {
  await emit("message.updated", {
    info: { id: "a", sessionID: "s", role: "assistant", parentID: "u" },
  });
  await emit("message.part.updated", {
    part: {
      id: "p",
      sessionID: "s",
      messageID: "a",
      type: "text",
      time: { end: 1 },
      text: scenario.fullyPrivate
        ? "<private>PRIVATE_ONLY</private>"
        : "Implemented synthetic fix; tests passed",
    },
  });
  await emit("session.idle", { sessionID: "s" });
  armedCount = armed.length;
  savedBefore = await mgr.getCaptureEvidence(id, project);
  gone = true;
  if (scenario.restart) {
    await plugin.dispose();
    await tursoConnectionManager.closeAll();
    mgr.reset();
    getsBeforeRestart = hostGets;
    plugin = await OpenCodeMemPlugin(ctx);
    // Startup recovery is intentionally fire-and-forget. Wait for its durable
    // completion rather than bypassing it by calling performAutoCapture.
    for (let i = 0; i < 100 && counters.persist === 0; i++)
      await new Promise((r) => realTimeout(r, 10));
  } else {
    await emit("session.deleted", { sessionID: "s" });
    await fire();
  }
  await awaitCaptureDrain();
  const prompt = await mgr.getPromptById(id);
  console.log(
    "PLUGIN_RESULT=" +
      JSON.stringify({
        counters,
        armedCount,
        savedBefore,
        prompt,
        hostGetsAfterRestart: hostGets - getsBeforeRestart,
        logs,
      })
  );
} finally {
  await plugin.dispose();
  await tursoConnectionManager.closeAll();
  await cleanupTursoTestDirectory(dir);
}
