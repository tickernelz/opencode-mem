import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");
const GLOBAL_PLUGIN_WARMUP_PROMISE_KEY = Symbol.for("opencode-mem.plugin.warmupPromise");
const originalSetTimeout = globalThis.setTimeout;

const CONFIG = {
  webServerEnabled: true,
  webServerPort: 3456,
  webServerHost: "127.0.0.1",
  autoCaptureLanguage: "en",
  autoCaptureEnabled: false,
  showErrorToasts: false,
  chatMessage: {
    enabled: false,
    injectOn: "always",
    maxMemories: 10,
    excludeCurrentSession: false,
  },
  compaction: {
    enabled: false,
    memoryLimit: 10,
  },
};

type TestState = {
  configured: boolean;
  isReady: boolean;
  warmupCalls: number;
  resetWarmupStateCalls: number;
  events: string[];
  timeoutCallbacks: Array<() => void>;
  startWebServerImpl: () => Promise<MockWebServer>;
  warmupImpl: () => Promise<void>;
};

type MockWebServer = {
  getUrl: () => string;
  isServerOwner: () => boolean;
  setOnTakeoverCallback: (callback: () => Promise<void>) => void;
  stop: () => Promise<void>;
};

const testState: TestState = {
  configured: true,
  isReady: false,
  warmupCalls: 0,
  resetWarmupStateCalls: 0,
  events: [],
  timeoutCallbacks: [],
  startWebServerImpl: async () => createMockWebServer(),
  warmupImpl: async () => {},
};

function createMockWebServer(): MockWebServer {
  return {
    getUrl: () => `http://${CONFIG.webServerHost}:${CONFIG.webServerPort}`,
    isServerOwner: () => true,
    setOnTakeoverCallback: () => {},
    stop: async () => {},
  };
}

function resetWarmupGlobals() {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  delete globalState[GLOBAL_PLUGIN_WARMUP_KEY];
  delete globalState[GLOBAL_PLUGIN_WARMUP_PROMISE_KEY];
}

function resetTestState() {
  CONFIG.webServerEnabled = true;
  CONFIG.webServerPort = 3456;
  CONFIG.webServerHost = "127.0.0.1";

  testState.configured = true;
  testState.isReady = false;
  testState.warmupCalls = 0;
  testState.resetWarmupStateCalls = 0;
  testState.events = [];
  testState.timeoutCallbacks = [];
  testState.startWebServerImpl = async () => {
    testState.events.push("server:start", "server:ready");
    return createMockWebServer();
  };
  testState.warmupImpl = async () => {};
}

function createPluginInput() {
  return {
    directory: "/tmp/opencode-mem-runtime-test",
    client: {
      path: {
        get: async () => ({ data: {} }),
      },
      provider: {
        list: async () => ({ data: {} }),
      },
      session: {
        messages: async () => ({ data: [] }),
        prompt: async () => ({}),
      },
    },
  } as any;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

mock.module("@opencode-ai/plugin", () => {
  const optional = () => ({ optional });
  const toolFactory = (definition: Record<string, unknown>) => definition;

  return {
    tool: Object.assign(toolFactory, {
      schema: {
        enum: optional,
        string: optional,
        number: optional,
      },
    }),
  };
});

mock.module("../src/config.js", () => ({
  CONFIG,
  initConfig: () => {},
  isConfigured: () => testState.configured,
}));

mock.module("../src/services/client.js", () => ({
  memoryClient: {
    warmup: () => {
      testState.warmupCalls += 1;
      testState.events.push("warmup:start");
      return testState.warmupImpl();
    },
    isReady: async () => testState.isReady,
    close: () => {},
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => ({ success: true, id: "mem-1" }),
    searchMemories: async () => ({ success: true, results: [], total: 0, timing: 0 }),
    deleteMemory: async () => ({ success: true }),
    searchMemoriesBySessionID: async () => ({ success: true, results: [], total: 0, timing: 0 }),
  },
}));

mock.module("../src/services/context.js", () => ({
  formatContextForPrompt: () => "",
}));

mock.module("../src/services/tags.js", () => ({
  getTags: () => ({
    project: {
      tag: "project_tag",
      displayName: "Project",
      userName: "User",
      userEmail: "user@example.com",
      projectPath: "/tmp/opencode-mem-runtime-test",
      projectName: "opencode-mem-runtime-test",
      gitRepoUrl: "https://github.com/tickernelz/opencode-mem",
    },
    user: {
      userEmail: "user@example.com",
    },
  }),
}));

mock.module("../src/services/privacy.js", () => ({
  stripPrivateContent: (content: string) => content,
  isFullyPrivate: () => false,
}));

mock.module("../src/services/auto-capture.js", () => ({
  performAutoCapture: async () => {},
}));

mock.module("../src/services/user-memory-learning.js", () => ({
  performUserProfileLearning: async () => {},
}));

mock.module("../src/services/user-prompt/user-prompt-manager.js", () => ({
  userPromptManager: {
    savePrompt: () => {},
  },
}));

mock.module("../src/services/web-server.js", () => ({
  startWebServer: () => testState.startWebServerImpl(),
}));

mock.module("../src/services/embedding.js", () => ({
  embeddingService: {
    resetWarmupState: () => {
      testState.resetWarmupStateCalls += 1;
    },
  },
}));

mock.module("../src/services/logger.js", () => ({
  log: () => {},
}));

mock.module("../src/services/language-detector.js", () => ({
  getLanguageName: () => "English",
}));

mock.module("../src/services/ai/opencode-provider.js", () => ({
  setStatePath: () => {},
  setConnectedProviders: () => {},
}));

const { OpenCodeMemPlugin } = await import("../src/index.ts");

describe("web server startup order", () => {
  let processOnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetTestState();
    resetWarmupGlobals();

    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
      testState.timeoutCallbacks.push(() => {
        if (typeof handler === "function") {
          handler(...args);
        }
      });
      return 0 as any;
    }) as typeof setTimeout;

    processOnSpy = spyOn(process, "on").mockImplementation(() => process as any);
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    processOnSpy.mockRestore();
    resetWarmupGlobals();
  });

  it("waits for web server startup to finish before background warmup begins", async () => {
    let resolveServer!: (server: MockWebServer) => void;

    testState.startWebServerImpl = () => {
      testState.events.push("server:start");
      return new Promise<MockWebServer>((resolve) => {
        resolveServer = (server) => {
          testState.events.push("server:ready");
          resolve(server);
        };
      });
    };

    const pluginPromise = OpenCodeMemPlugin(createPluginInput());
    await flushMicrotasks();

    expect(testState.events).toEqual(["server:start"]);
    expect(testState.warmupCalls).toBe(0);

    resolveServer(createMockWebServer());
    await pluginPromise;

    expect(testState.events).toEqual(["server:start", "server:ready", "warmup:start"]);
  });

  it("keeps the memory tool non-blocking while initialization is still running", async () => {
    CONFIG.webServerEnabled = false;

    testState.warmupImpl = () => new Promise<void>(() => {});

    const hooks = await OpenCodeMemPlugin(createPluginInput());
    expect(testState.warmupCalls).toBe(1);

    const result = await Promise.race([
      (hooks.tool as any).memory.execute({}, { sessionID: "session-1" }),
      new Promise((resolve) => originalSetTimeout(() => resolve("__timeout__"), 25)),
    ]);

    expect(result).not.toBe("__timeout__");
    expect(JSON.parse(String(result))).toEqual({
      success: false,
      error: "Memory system is initializing.",
    });
    expect(testState.warmupCalls).toBe(1);
  });

  it("allows a new warmup attempt after a timed-out warmup clears stale state", async () => {
    CONFIG.webServerEnabled = false;

    let attempt = 0;
    testState.warmupImpl = () => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    };

    const hooks = await OpenCodeMemPlugin(createPluginInput());
    expect(testState.warmupCalls).toBe(1);
    expect(testState.timeoutCallbacks).toHaveLength(1);

    testState.timeoutCallbacks[0]?.();
    await flushMicrotasks();

    const result = JSON.parse(
      String(await (hooks.tool as any).memory.execute({}, { sessionID: "session-1" }))
    );

    expect(result).toEqual({ success: false, error: "Memory system is initializing." });
    expect(testState.resetWarmupStateCalls).toBe(1);
    expect(testState.warmupCalls).toBe(2);
  });
});
