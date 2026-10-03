import { mock } from "bun:test";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const config = {
  chatMessage: {
    enabled: true,
    injectOn: "first",
    maxMemories: 3,
    excludeCurrentSession: true,
    filterInjectedPrompts: true,
  },
  compaction: { enabled: false },
  autoCaptureEnabled: false,
  webServerEnabled: false,
  autoUpdate: { enabled: false },
  storagePath: process.argv[2],
  opencodeModel: "inherit",
};
let configured = true;
let memories = [{ summary: "original project knowledge", createdAt: new Date().toISOString() }];
let failLookup = false;
let lookupCount = 0;
const captures = [];
const histories = new Map();
const titles = new Map();
mock.module(moduleUrl("config"), () => ({
  CONFIG: config,
  initConfig() {},
  isConfigured: () => configured,
}));
mock.module(moduleUrl("memory/client"), () => ({
  memoryClient: {
    warmup: async () => {},
    close: async () => {},
    listMemories: async () => {
      lookupCount++;
      if (failLookup) throw new Error("fixture lookup failure");
      return { success: true, memories };
    },
  },
}));
mock.module(moduleUrl("memory/tags"), () => ({
  getTags: () => ({
    project: { tag: "fixture-project" },
    user: { userEmail: "fixture-user" },
  }),
}));
mock.module(moduleUrl("memory/context"), () => ({
  formatContextForPrompt: async (_user, data) =>
    "<memory_context>" + data.results.map((m) => m.memory).join("|") + "</memory_context>",
}));
mock.module(moduleUrl("memory/user-prompt/user-prompt-manager"), () => ({
  userPromptManager: {
    savePrompt: async (...args) => captures.push(args),
    setPromptModel: async () => {},
  },
}));
mock.module(moduleUrl("infra/logger"), () => ({ log() {} }));
mock.module(moduleUrl("runtime/http/web-server"), () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(moduleUrl("infra/auto-update"), () => ({ startAutoUpdate() {} }));
const { OpenCodeMemPlugin } = await import(moduleUrl("index"));
const { registerV2Adapter } = await import(moduleUrl("v2/adapter"));
const client = {
  provider: { list: async () => ({ data: { connected: [] } }) },
  session: {
    messages: async ({ path }) => ({ data: histories.get(path.id) ?? [] }),
    get: async ({ path }) => ({ data: { title: titles.get(path.id) ?? "regular task" } }),
  },
};
const plugin = await OpenCodeMemPlugin({ directory: "/fixture-project", client });
async function adapter() {
  const hooks = new Map();
  const cleanup = await registerV2Adapter(
    {
      location: {
        directory: "/fixture-project",
        project: { directory: "/fixture-project" },
      },
      tool: { transform: async () => {} },
      session: { hook: async (name, callback) => hooks.set(name, callback) },
    },
    { ...plugin, event: undefined, dispose: undefined }
  );
  return {
    async prompt(sessionID, text, id) {
      const event = { sessionID, messageID: id, prompt: { text } };
      await hooks.get("prompt")(event);
      const history = histories.get(sessionID) ?? [];
      history.push({
        info: { role: "user", id },
        parts: [{ type: "text", text }],
      });
      histories.set(sessionID, history);
      return event.prompt.text;
    },
    async context(sessionID) {
      const event = {
        sessionID,
        model: { providerID: "fixture", id: "fixture" },
        system: [],
      };
      await hooks.get("context")(event);
      return event.system.map((p) => p.text);
    },
    cleanup,
  };
}
const output = {};
let host = await adapter();
output.authored = await host.prompt("first", "authored first prompt", "msg-1");
output.first = await host.context("first");
memories = [{ summary: "new project knowledge", createdAt: new Date().toISOString() }];
await host.prompt("first", "authored second prompt", "msg-2");
output.second = await host.context("first");
output.modelStep = await host.context("first");
output.firstLookups = lookupCount;
await host.cleanup();
host = await adapter();
const capturesBeforeReload = captures.length;
output.resumed = await host.context("first");
output.resumeCaptured = captures.length - capturesBeforeReload;
await host.prompt("first", "authored after reload", "msg-3");
output.afterResume = await host.context("first");
memories = [{ summary: "other session knowledge", createdAt: new Date().toISOString() }];
output.otherSession = await host.context("other");
output.originalSessionAfterOther = await host.context("first");
config.chatMessage.injectOn = "always";
await host.prompt("always", "first always prompt", "msg-4");
output.alwaysFirst = await host.context("always");
memories = [{ summary: "refreshed project knowledge", createdAt: new Date().toISOString() }];
await host.prompt("always", "second always prompt", "msg-5");
output.alwaysSecond = await host.context("always");
memories = [];
await host.prompt("always", "empty lookup prompt", "msg-6");
output.empty = await host.context("always");
memories = [{ summary: "after empty lookup", createdAt: new Date().toISOString() }];
await host.prompt("always", "recovery prompt", "msg-7");
output.recovered = await host.context("always");
failLookup = true;
await host.prompt("always", "failed lookup prompt", "msg-8");
output.failed = await host.context("always");
failLookup = false;
await host.prompt("always", "retry prompt", "msg-9");
output.retried = await host.context("always");
config.chatMessage.enabled = false;
output.disabled = await host.context("always");
config.chatMessage.enabled = true;
configured = false;
output.unconfigured = await host.context("always");
configured = true;
await host.prompt("first", "# User Profile Analysis", "internal-1");
output.internalPrompt = await host.context("first");
await host.prompt("first", "<system-reminder>injected boilerplate</system-reminder>", "internal-2");
output.injectedOnly = await host.context("first");
await host.prompt("first", "   ", "internal-3");
output.blank = await host.context("first");
await host.prompt("first", "back to real work", "msg-10");
output.realAfterInternal = await host.context("first");
await host.cleanup();
host = await adapter();
const capturesBeforeAlwaysResume = captures.length;
output.alwaysResumed = await host.context("always");
output.alwaysResumeCaptured = captures.length - capturesBeforeAlwaysResume;
config.chatMessage.injectOn = "first";
memories = [{ summary: "cold prompt knowledge", createdAt: new Date().toISOString() }];
await host.prompt("first", "first prompt after cold reload", "msg-11");
output.coldPrompt = await host.context("first");
config.chatMessage.maxAgeDays = 1;
memories = [
  { summary: "eligible knowledge", createdAt: new Date().toISOString() },
  {
    summary: "excluded current session",
    metadata: { sessionID: "filtered" },
    createdAt: new Date().toISOString(),
  },
  { summary: "expired knowledge", createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
];
output.filteredResume = await host.context("filtered");
titles.set("internal", "opencode-mem capture");
output.internalResume = await host.context("internal");
output.captures = captures.map(([sessionID, messageID, , text]) => ({
  sessionID,
  messageID,
  text,
}));
// V1 still injects synthetic message parts according to its history policy.
const v1 = {
  message: { id: "v1-first" },
  parts: [{ type: "text", text: "v1 user prompt" }],
};
await plugin["chat.message"]({ sessionID: "v1" }, v1);
output.v1First = v1.parts;
histories.set("v1", [{ info: { role: "user" }, parts: [{ type: "text", text: "prior" }] }]);
const later = {
  message: { id: "v1-later" },
  parts: [{ type: "text", text: "later v1 prompt" }],
};
await plugin["chat.message"]({ sessionID: "v1" }, later);
output.v1Later = later.parts;
await host.cleanup();
await plugin.dispose();
console.log(JSON.stringify(output));
