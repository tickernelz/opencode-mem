/**
 * Provider-connectivity refresh scenarios (late provider registration).
 *
 * Root cause being regression-guarded: at plugin setup the provider
 * directory often lists only the built-in broker ('opencode'); user-config
 * providers (e.g. 'newapi') register a few seconds later and the host emits
 * provider.updated / model.updated. The plugin must refresh its
 * connectivity snapshot on those events (and on gate misses) instead of
 * trusting the init-time snapshot forever.
 *
 * Runs the real plugin (src/index.js), the real v2 adapter/legacy-client
 * event path, and the real opencode-provider module state. Only peripheral
 * services are mocked. Spawned by tests/v2-provider-refresh.test.ts with
 * HOME/XDG redirected to an isolated sandbox; scenario via argv[2].
 */
import { mock } from "bun:test";

const scenario = process.argv[2] ?? "bootstrap";
const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;

// Directory fixture state, per scenario:
// - bootstrap/burst/dispose/miss: call #1 sees only the broker, later calls
//   also include newapi (registered ~2s after setup, like the real host).
// - capture-error: newapi never appears (miss refresh must still fail).
// - refresh-error: newapi is present from call #1, but every refresh
//   (call >= 2) throws — the previous set must be retained.
const newapiFromCall =
  scenario === "refresh-error" ? 1 : scenario === "capture-error" ? Infinity : 2;
const failFromCall = scenario === "refresh-error" ? 2 : 0;
const listDelayMs = scenario === "burst" ? 25 : 0;

let listCalls = 0;
const logs = [];
const toasts = [];
let failedAttempts = 0;
let released = false;
let claimed = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listProviders() {
  listCalls += 1;
  if (failFromCall && listCalls >= failFromCall) {
    throw new Error("provider directory unavailable");
  }
  if (listDelayMs) await sleep(listDelayMs);
  const data = [
    { id: "opencode", activation: "enabled", name: "OpenCode", package: "opencode-pkg" },
  ];
  if (listCalls >= newapiFromCall) {
    data.push({ id: "newapi", activation: "enabled", name: "NewAPI", package: "newapi-pkg" });
  }
  return { location: { directory: "/workspace/project" }, data };
}

async function poll(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

mock.module(moduleUrl("config"), () => ({
  CONFIG: {
    autoCaptureEnabled: false,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureMaxRetries: 1,
    autoCaptureLanguage: "en",
    opencodeProvider: "newapi",
    opencodeModel: "test-model",
    showAutoCaptureToasts: false,
    showErrorToasts: true,
    chatMessage: { enabled: false },
    compaction: { enabled: false },
    webServerEnabled: false,
    autoUpdate: { enabled: false },
    storagePath: process.env.HOME,
  },
  initConfig() {},
  isConfigured: () => true,
}));

mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    warmup: async () => {},
    close: async () => {},
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => ({ success: true, id: "mem-unexpected" }),
  },
}));

mock.module(moduleUrl("services/tags"), () => ({
  getTags: () => ({
    project: { tag: "fixture-project", projectPath: "/workspace/project" },
    user: { userEmail: "fixture-user" },
  }),
}));

mock.module(moduleUrl("services/context"), () => ({
  formatContextForPrompt: async () => "",
}));

const promptRows = [
  {
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    projectPath: "/workspace/project",
    content: "Implement the provider gate fix",
    createdAt: 1,
    captured: false,
    capture_attempts: 0,
  },
];

mock.module(moduleUrl("services/user-prompt/user-prompt-manager"), () => ({
  userPromptManager: {
    getCaptureEvidence: async () => null,
    getPendingCaptureSessions: async () => [],
    markCaptureEvidenceReady: async () => {},
    savePrompt: async () => {},
    setPromptModel: async () => {},
    getUncapturedPromptsForSession: async () => (claimed ? [] : promptRows),
    claimPrompt: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    recordFailedAttempt: async () => {
      failedAttempts += 1;
    },
    releaseClaim: async () => {
      released = true;
      claimed = false;
      return true;
    },
    linkMemoryToPrompt: async () => {},
    markAsCaptured: async () => {},
    deletePrompt: async () => {},
  },
}));

mock.module(moduleUrl("services/logger"), () => ({
  log: (...args) =>
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  safeLog: (...args) =>
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  serializeError: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
}));

mock.module(moduleUrl("services/web-server"), () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));

mock.module(moduleUrl("services/auto-update"), () => ({ startAutoUpdate() {} }));

const { OpenCodeMemPlugin } = await import(moduleUrl("index"));
const { registerV2Adapter } = await import(moduleUrl("v2/adapter"));
const { createLegacyClient } = await import(moduleUrl("v2/legacy-client"));
const opencodeProvider = await import(moduleUrl("services/ai/opencode-provider"));

const fakeCtx = {
  location: { directory: "/workspace/project", project: { directory: "/workspace/project" } },
  provider: { list: listProviders },
  model: {
    list: async () => {
      throw new Error("model.list must not be called for provider connectivity");
    },
  },
};
const client = createLegacyClient(fakeCtx);
const plugin = await OpenCodeMemPlugin({ directory: "/workspace/project", client });

/** Real adapter wiring; events stay gated until init has settled. */
function makeAdapter(events) {
  let releaseGate;
  const gate = new Promise((resolve) => (releaseGate = resolve));
  let resolveDrained;
  const drained = new Promise((resolve) => (resolveDrained = resolve));
  const ctx = {
    location: {
      directory: "/workspace/project",
      project: { id: "project", directory: "/workspace/project", canonical: "project" },
    },
    tool: { transform: async () => {} },
    session: { hook: async () => {} },
    event: {
      async *subscribe({ signal }) {
        await gate;
        for (const event of events) yield event;
        resolveDrained();
        await new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      },
    },
  };
  return { ctx, releaseGate, drained };
}

const output = {};

if (scenario === "bootstrap") {
  const adapter = makeAdapter([
    { type: "provider.updated", location: { directory: "/workspace/project" }, data: {} },
  ]);
  const cleanup = await registerV2Adapter(adapter.ctx, plugin);
  const initSettled = await poll(() => opencodeProvider.isProviderConnected("opencode"));
  output.initSettled = initSettled;
  output.initListCalls = listCalls;
  output.afterInitOnlyOpencode =
    initSettled && !opencodeProvider.isProviderConnected("newapi") && listCalls === 1;
  adapter.releaseGate();
  await adapter.drained;
  output.afterEventNewapi = await poll(() => opencodeProvider.isProviderConnected("newapi"));
  output.eventListCalls = listCalls;
  await cleanup();
  await plugin.dispose();
} else if (scenario === "miss") {
  const initSettled = await poll(() => opencodeProvider.isProviderConnected("opencode"));
  output.initSettled = initSettled;
  output.callsAfterInit = listCalls;
  output.missNewapi = (await opencodeProvider.ensureProviderConnected("newapi")) === true;
  output.callsAfterMiss = listCalls;
  output.missGhost = (await opencodeProvider.ensureProviderConnected("ghost")) === false;
  output.finalCalls = listCalls;
  await plugin.dispose();
} else if (scenario === "capture-error") {
  const initSettled = await poll(() => opencodeProvider.isProviderConnected("opencode"));
  const { performAutoCapture } = await import(moduleUrl("services/auto-capture"));
  await performAutoCapture(
    {
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "msg-1", role: "user" },
                parts: [{ type: "text", text: "Implement the provider gate fix" }],
              },
              {
                info: { id: "asst-1", role: "assistant" },
                parts: [{ type: "text", text: "Implemented it" }],
              },
            ],
          }),
        },
        tui: {
          showToast: async (toast) => {
            toasts.push(toast);
            return {};
          },
        },
      },
    },
    "session-1",
    "/workspace/project"
  );
  output.initSettled = initSettled;
  output.toastMessage = toasts[0]?.body?.message ?? null;
  output.failedAttempts = failedAttempts;
  output.released = released;
  output.refreshCalls = listCalls - 1;
  await plugin.dispose();
} else if (scenario === "refresh-error") {
  const adapter = makeAdapter([
    { type: "provider.updated", location: { directory: "/workspace/project" }, data: {} },
  ]);
  const cleanup = await registerV2Adapter(adapter.ctx, plugin);
  output.initSettled = await poll(
    () =>
      opencodeProvider.isProviderConnected("opencode") &&
      opencodeProvider.isProviderConnected("newapi")
  );
  adapter.releaseGate();
  await adapter.drained;
  output.refreshAttempted = await poll(() => listCalls >= 2);
  await sleep(50);
  output.newapiStillConnected = opencodeProvider.isProviderConnected("newapi");
  output.errorLogged = logs.some((l) => l.includes("Failed to refresh opencode provider state"));
  output.listCalls = listCalls;
  await cleanup();
  await plugin.dispose();
} else if (scenario === "burst") {
  const events = [];
  for (let i = 0; i < 12; i++) {
    // Location-bearing (and one payload-envelope) events so the V2 adapter's
    // eventBelongsToLocation filter forwards the whole burst into legacy.event.
    events.push(
      i % 2
        ? {
            type: "model.updated",
            location: { directory: "/workspace/project" },
            data: {},
          }
        : {
            type: "provider.updated",
            location: { directory: "/workspace/project" },
            data: {},
          }
    );
  }
  events[11] = {
    payload: {
      type: "provider.updated",
      location: { directory: "/workspace/project" },
      data: {},
    },
  };
  const adapter = makeAdapter(events);
  const cleanup = await registerV2Adapter(adapter.ctx, plugin);
  output.initSettled = await poll(
    () => opencodeProvider.isProviderConnected("opencode") && listCalls === 1
  );
  adapter.releaseGate();
  await adapter.drained;
  output.refreshed = await poll(() => opencodeProvider.isProviderConnected("newapi"));
  await sleep(120);
  output.listCalls = listCalls;
  await cleanup();
  await plugin.dispose();
} else if (scenario === "dispose") {
  const adapter = makeAdapter([]);
  const cleanup = await registerV2Adapter(adapter.ctx, plugin);
  output.initSettled = await poll(() => opencodeProvider.isProviderConnected("opencode"));
  output.callsBeforeDispose = listCalls;
  // Unblock the (empty) event stream so the adapter watcher can finish.
  adapter.releaseGate();
  await adapter.drained;
  await cleanup();
  await plugin.event({ event: { type: "provider.updated", properties: {} } });
  await sleep(120);
  output.callsAfterDisposeEvent = listCalls;
  output.ghostFalseAfterDispose =
    (await opencodeProvider.ensureProviderConnected("ghost")) === false;
  output.opencodeStillConnected = opencodeProvider.isProviderConnected("opencode");
  await plugin.dispose();
} else {
  console.error("unknown scenario: " + scenario);
  process.exit(64);
}

console.log(JSON.stringify(output));
