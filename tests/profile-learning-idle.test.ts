import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/memory/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/memory/tags.js", import.meta.url).href;
const contextUrl = new URL("../src/memory/context.js", import.meta.url).href;
const privacyUrl = new URL("../src/infra/privacy.js", import.meta.url).href;
const autoCaptureUrl = new URL("../src/memory/auto-capture.js", import.meta.url).href;
const learningUrl = new URL("../src/memory/user-memory-learning.js", import.meta.url).href;
const cleanupUrl = new URL("../src/memory/cleanup-service.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/memory/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const webServerUrl = new URL("../src/runtime/http/web-server.js", import.meta.url).href;
const loggerUrl = new URL("../src/infra/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/infra/language-detector.js", import.meta.url).href;
const tursoReadyUrl = new URL("../src/storage/turso/ready.js", import.meta.url).href;

/**
 * Drives the real plugin's `session.idle` handler in an isolated Bun process so
 * the module mocks below cannot leak into sibling test files, then reports which
 * background jobs the handler actually invoked.
 */
function runIdleScenario(opts: {
  owner?: boolean;
  webServerEnabled?: boolean;
  internalSession?: boolean;
  autoCaptureEnabled?: boolean;
}) {
  const owner = opts.owner ?? false;
  const webServerEnabled = opts.webServerEnabled ?? true;
  const internalSession = opts.internalSession ?? false;
  const autoCaptureEnabled = opts.autoCaptureEnabled ?? true;

  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-idle-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const calls = [];

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureEnabled: ${autoCaptureEnabled},
    compaction: { enabled: false, memoryLimit: 10 },
    chatMessage: { enabled: false },
    webServerEnabled: ${webServerEnabled},
    storagePath: ${JSON.stringify(dir)},
    autoCaptureProviderStatus: { ready: true, issues: [] },
  },
  initConfig: () => {},
  isConfigured: () => true,
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({ project: { tag: "project-tag" }, user: { userEmail: "u@example.com" } }),
}));
mock.module(${JSON.stringify(contextUrl)}, () => ({ formatContextForPrompt: () => "" }));
mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (value) => value,
  isFullyPrivate: () => false,
}));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({ userPromptManager: { savePrompt() {} } }));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));
// The web server only starts once the Turso readiness gate passes, and that
// gate is what decides whether an owner exists at all.
mock.module(${JSON.stringify(tursoReadyUrl)}, () => ({ ensureTursoReady: async () => {} }));
// The internal-capture check lives inside src/hosts/opencode/plugin.ts and resolves the session
// title through the client, so drive it the real way: report the reserved title.
const INTERNAL_TITLE = "opencode-mem capture";

mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({
  performAutoCapture: async () => { calls.push("capture"); },
  awaitCaptureDrain: async () => {},
}));
mock.module(${JSON.stringify(learningUrl)}, () => ({
  performUserProfileLearning: async () => { calls.push("learn"); },
}));
mock.module(${JSON.stringify(cleanupUrl)}, () => ({
  cleanupService: {
    shouldRunCleanup: async () => true,
    runCleanup: async () => { calls.push("cleanup"); },
  },
}));

mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => (${webServerEnabled}
    ? {
        isServerOwner: () => ${owner},
        getUrl: () => "http://127.0.0.1:4747",
        setOnTakeoverCallback: () => {},
        stop: async () => {},
      }
    : null),
  WebServer: class {},
}));

const mockClient = {
  session: {
    get: async () => ({ data: ${internalSession} ? { title: INTERNAL_TITLE } : { title: "regular work" } }),
    messages: async () => ({ data: [] }),
  },
  tui: { showToast: async () => ({}) },
};

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({ directory: "/active-project", client: mockClient });

// Let the plugin's async web-server bootstrap settle before the idle event, so
// ownership is resolved the same way it is at runtime.
await new Promise((resolve) => setTimeout(resolve, 50));

await plugin.event({
  event: { type: "session.idle", properties: { sessionID: "user-session" } },
});

// The handler debounces idle work behind a 10s timer.
await new Promise((resolve) => setTimeout(resolve, 10_600));

console.log(JSON.stringify({ calls }));
`;

  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  return {
    exitCode: result.exitCode,
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    calls: stdout ? (JSON.parse(stdout).calls as string[]) : null,
  };
}

describe("profile learning trigger on session.idle", () => {
  it("learns from an active instance that does not own the web server", () => {
    const result = runIdleScenario({ owner: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual(["capture", "learn"]);
  }, 30_000);

  it("learns when the web server is disabled entirely", () => {
    // Regression guard: with no web server there is no owner at all, so gating
    // learning on ownership disabled profile learning permanently.
    const result = runIdleScenario({ webServerEnabled: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual(["capture", "learn"]);
  }, 30_000);

  it("keeps retention cleanup owner-only", () => {
    const result = runIdleScenario({ owner: true });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual(["capture", "learn", "cleanup"]);
  }, 30_000);

  it("runs no cleanup on a non-owner", () => {
    const result = runIdleScenario({ owner: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).not.toContain("cleanup");
  }, 30_000);

  it("skips the plugin's own internal capture sessions", () => {
    const result = runIdleScenario({ internalSession: true });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual([]);
  }, 30_000);

  it("does nothing when auto-capture is disabled", () => {
    const result = runIdleScenario({ autoCaptureEnabled: false });

    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.calls).toEqual([]);
  }, 30_000);
});
