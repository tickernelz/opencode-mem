import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Auto-capture scheduling liveness: two independent finished sessions must
 * each get their capture consumed, without needing a future idle event.
 *
 * Drives the REAL plugin event handler and the REAL performAutoCapture in
 * isolated Bun children (module-mocked external boundaries only — config,
 * memory client, prompt manager, LLM loader), following the established
 * tests/profile-learning-idle.test.ts child-process pattern. Idle debounce
 * timers are captured and fired deterministically (no 10s wall sleeps).
 */

// file:// URL of the repo root (tests/). Never use URL.pathname: on Windows
// it yields "/D:/a/..." which is an invalid spawn cwd and a broken file URL
// base — resolve paths through fileURLToPath and URL-relative href instead.
const REPO_URL = new URL("../", import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_URL);

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

const u = (p: string) => new URL(p, REPO_URL).href;

/**
 * Spawns an isolated child and returns parsed stdout JSON. The child script
 * body has access to helper snippets defined here (timer harness, mocks).
 */
function runChild(scriptBody: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: any;
} {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-concurrency-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

// ---- deterministic 10s idle-timer harness (installed before plugin import) ----
const armed = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, delay, ...rest) => {
  const h = realSetTimeout(fn, delay, ...rest);
  if (delay === 10000) armed.push({ handle: h, fn });
  return h;
};
globalThis.clearTimeout = (h) => {
  const i = armed.findIndex((t) => t.handle === h);
  if (i !== -1) armed.splice(i, 1);
  return realClearTimeout(h);
};
const settle = (ms = 50) => new Promise((r) => realSetTimeout(r, ms));
const fireIdleTimers = async () => {
  const live = armed.splice(0);
  for (const t of live) { realClearTimeout(t.handle); await t.fn(); }
};
const fireIdleTimerFor = async (sid, captureApi) => {
  // fire only the timer belonging to one session (identified via captureApi tag)
  const idx = armed.findIndex((t) => t.sid === sid);
  if (idx === -1) return false;
  const t = armed.splice(idx, 1)[0];
  realClearTimeout(t.handle);
  await t.fn();
  return true;
};

// ---- shared external boundaries (real boundaries, fake content) ----
mock.module(${JSON.stringify(u("src/memory/client.js"))}, () => ({
  memoryClient: { warmup: async () => {}, isReady: async () => true, close() {} },
}));
mock.module(${JSON.stringify(u("src/memory/context.js"))}, () => ({ formatContextForPrompt: () => "" }));
mock.module(${JSON.stringify(u("src/infra/privacy.js"))}, () => ({
  stripPrivateContent: (v) => v, isFullyPrivate: () => false,
}));
mock.module(${JSON.stringify(u("src/infra/logger.js"))}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(u("src/infra/language-detector.js"))}, () => ({
  detectLanguage: () => "en", getLanguageName: () => "English",
}));
mock.module(${JSON.stringify(u("src/storage/turso/ready.js"))}, () => ({ ensureTursoReady: async () => {} }));
mock.module(${JSON.stringify(u("src/runtime/http/web-server.js"))}, () => ({
  startWebServer: async () => null, WebServer: class {},
}));
mock.module(${JSON.stringify(u("src/memory/cleanup-service.js"))}, () => ({
  cleanupService: { shouldRunCleanup: async () => false, runCleanup: async () => {} },
}));

${scriptBody}
`;

  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // scenario may print diagnostics before final JSON on failure
  }
  return { exitCode: result.exitCode, stdout, stderr, parsed };
}

/** Common plugin-level mocks for scenarios that import the real index.ts. */
const PLUGIN_MOCKS = `
mock.module(${JSON.stringify(u("src/config.js"))}, () => ({
  CONFIG: {
    autoCaptureEnabled: true,
    compaction: { enabled: false },
    chatMessage: { enabled: false },
    webServerEnabled: false,
    storagePath: process.env.LANE_TEMP_DIR,
    autoCaptureProviderStatus: { ready: true, issues: [] },
  },
  initConfig: () => {}, isConfigured: () => true,
}));
mock.module(${JSON.stringify(u("src/memory/tags.js"))}, () => ({
  getTags: () => ({ project: { tag: "opencode_project_test", displayName: "T", userName: "U", userEmail: "u@example.com", projectPath: "/w", projectName: "w" } }),
}));
const captureSIDs = [];
mock.module(${JSON.stringify(u("src/memory/user-prompt/user-prompt-manager.js"))}, () => ({
  userPromptManager: {
    savePrompt() {},
    async getUncapturedPromptsForSession(sid) { captureSIDs.push(sid + ":query"); return []; },
  },
}));
const { OpenCodeMemPlugin } = await import(${JSON.stringify(u("src/index.js"))});
const titles = new Map();
const mockClient = {
  session: {
    get: async ({ path }) => ({ data: { title: titles.get(path.id) ?? "regular work" } }),
    messages: async () => ({ data: [] }),
  },
  tui: { showToast: async () => ({}) },
};
const plugin = await OpenCodeMemPlugin({ directory: "/w", client: mockClient });
await settle();
const emitIdle = (sid, title) => {
  if (title) titles.set(sid, title);
  return plugin.event({ event: { type: "session.idle", properties: { sessionID: sid } } });
};
`;

describe("auto-capture scheduling liveness (per-session timers + serial queue)", () => {
  it("A then B (same directory, before A's deadline): both sessions capture exactly once", () => {
    const r = runChild(`
${PLUGIN_MOCKS}

// Real index.ts event handler arming per-session timers. NOTE: index.ts calls
// the REAL performAutoCapture (auto-capture.js is not module-mocked here); its
// getUncapturedPromptsForSession is the instrumented prompt-manager above, and
// empty prompts => early return, which is the boundary this test asserts on:
// which session IDs the scheduler actually dispatches work for.
await emitIdle("sess-A");
await settle(20);
await emitIdle("sess-B");   // must NOT cancel A's pending timer anymore
await settle(20);

const armedCount = armed.length;
await fireIdleTimers();     // both sessions finished — no future idle events
await settle();

console.log(JSON.stringify({ captureSIDs, armedCount }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    const queries = r.parsed.captureSIDs.filter((s) => s.endsWith(":query"));
    expect(queries.filter((s) => s.startsWith("sess-A"))).toHaveLength(1);
    expect(queries.filter((s) => s.startsWith("sess-B"))).toHaveLength(1);
    // two distinct sessions => two independent timers armed before flush
    expect(r.parsed.armedCount).toBe(2);
  }, 30_000);

  it("same session x3 rapid idles still debounce to exactly one capture", () => {
    const r = runChild(`
${PLUGIN_MOCKS}

for (let i = 0; i < 3; i++) {
  await emitIdle("sess-X");
  await settle(10);
}
const armedCount = armed.length;
await fireIdleTimers();
await settle();

console.log(JSON.stringify({ captureSIDs, armedCount }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    const queries = r.parsed.captureSIDs.filter((s) => s.startsWith("sess-X:"));
    expect(queries).toHaveLength(1);
    expect(r.parsed.armedCount).toBe(1);
  }, 30_000);

  it("dispose clears all pending per-session timers; no capture fires afterwards", () => {
    const r = runChild(`
${PLUGIN_MOCKS}

await emitIdle("sess-A");
await settle(10);
await emitIdle("sess-B");
await settle(10);

const beforeDispose = armed.length;
await plugin.dispose();
const afterDispose = armed.length;
// nothing may dispatch even if we wait real time
await settle(80);

console.log(JSON.stringify({ captureSIDs, beforeDispose, afterDispose }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    expect(r.parsed.beforeDispose).toBe(2);
    expect(r.parsed.afterDispose).toBe(0);
    expect(r.parsed.captureSIDs).toHaveLength(0);
  }, 30_000);

  it("post-dispose late idle event does not arm a new timer (cleanedUp gate)", () => {
    const r = runChild(`
${PLUGIN_MOCKS}

await plugin.dispose();
await emitIdle("sess-LATE");
await settle(50);

console.log(JSON.stringify({ captureSIDs, armed: armed.length }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    // cleanedUp was set by dispose; the handler must not schedule new work.
    // (internal-capture check runs first, but a "regular work" title passes it;
    //  the guard we assert on is: no timer armed + no capture dispatched)
    expect(r.parsed.armed).toBe(0);
    expect(r.parsed.captureSIDs).toHaveLength(0);
  }, 30_000);
});

describe("auto-capture serial queue (real performAutoCapture)", () => {
  it("A's LLM paused: B enqueues behind it, then runs automatically after A releases (no second idle for B)", () => {
    const r = runChild(`
mock.module(${JSON.stringify(u("src/config.js"))}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai", opencodeModel: "gpt-test",
    showAutoCaptureToasts: false, showErrorToasts: false,
  },
}));

// in-memory prompt rows — the only stateful fake boundary
const prompts = [
  { id: "pA", sessionId: "sess-A", messageId: "msg-A1", projectPath: "/w", content: "Fix login bug", createdAt: 1, captured: false, claimed: false, capture_attempts: 0 },
  { id: "pB", sessionId: "sess-B", messageId: "msg-B1", projectPath: "/w", content: "Add export API", createdAt: 2, captured: false, claimed: false, capture_attempts: 0 },
];
const counts = { query: {}, claim: {}, llm: {}, capture: {} };
const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };
mock.module(${JSON.stringify(u("src/memory/user-prompt/user-prompt-manager.js"))}, () => ({
  userPromptManager: {
    async getUncapturedPromptsForSession(sid) { bump(counts.query, sid); return prompts.filter((p) => p.sessionId === sid && !p.captured && !p.claimed); },
    async claimPrompt(id) { const p = prompts.find((x) => x.id === id); if (!p || p.captured || p.claimed) return false; p.claimed = true; bump(counts.claim, p.sessionId); return true; },
    async recordFailedAttempt(id) { const p = prompts.find((x) => x.id === id); if (p) p.capture_attempts += 1; },
    async releaseClaim(id) { const p = prompts.find((x) => x.id === id); if (p && p.claimed && !p.captured) { p.claimed = false; return true; } return false; },
    async linkMemoryToPrompt(id, memId) { const p = prompts.find((x) => x.id === id); if (p) p.linked = memId; },
    async markAsCaptured(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
    async deletePrompt(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
  },
}));
mock.module(${JSON.stringify(u("src/memory/client.js"))}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (_c, _t, metadata) => { bump(counts.capture, metadata.sessionID); return { success: true, id: "mem-" + metadata.promptId }; },
    close() {},
  },
}));
mock.module(${JSON.stringify(u("src/memory/tags.js"))}, () => ({
  getTags: () => ({ project: { tag: "opencode_project_test", displayName: "T", userName: "U", userEmail: "u@example.com", projectPath: "/w", projectName: "w" } }),
}));

let releaseA;
const gateA = new Promise((res) => { releaseA = res; });
// Resolves when A's LLM call has actually been entered (and is parked on the
// gate). Waiting on this instead of a fixed wall-clock settle keeps the
// duringBlock snapshot deterministic on slow runners (Windows CI: query+claim
// had completed within 30ms but the LLM entry had not).
let llmEnteredResolve;
const llmEntered = new Promise((res) => { llmEnteredResolve = res; });
const llmOrder = [];
mock.module(${JSON.stringify(u("src/ai/opencode-provider-loader.js"))}, () => ({
  loadOpencodeProvider: async () => ({
    isProviderConnected: () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      const sid = userPrompt.includes("Fix login bug") ? "sess-A" : "sess-B";
      llmOrder.push(sid); bump(counts.llm, sid);
      if (sid === "sess-A") { llmEnteredResolve(); await gateA; }
      return { summary: "stub " + sid, type: "discussion", tags: [] };
    },
  }),
}));

const messagesFor = {
  "sess-A": [
    { info: { id: "msg-A1", role: "user" }, parts: [{ type: "text", text: "Fix login bug" }] },
    { info: { id: "ai-A1", role: "assistant" }, parts: [{ type: "text", text: "Fixed auth.ts" }] },
  ],
  "sess-B": [
    { info: { id: "msg-B1", role: "user" }, parts: [{ type: "text", text: "Add export API" }] },
    { info: { id: "ai-B1", role: "assistant" }, parts: [{ type: "text", text: "Added api.ts" }] },
  ],
};
const ctxFor = (sid) => ({
  client: {
    session: { messages: async ({ path }) => ({ data: messagesFor[path.id] ?? [] }) },
    tui: { showToast: async () => ({}) },
  },
});

const { performAutoCapture } = await import(${JSON.stringify(u("src/memory/auto-capture.js"))});

// 1) A starts; its LLM call parks on the gate.
const aPromise = performAutoCapture(ctxFor("sess-A"), "sess-A", "/w");
await llmEntered;
const duringBlock = JSON.parse(JSON.stringify(counts));

// 2) B's idle fires while A is in flight — B must QUEUE, not be dropped.
const bPromise = performAutoCapture(ctxFor("sess-B"), "sess-B", "/w");
await settle(30);
const afterEnqueue = JSON.parse(JSON.stringify(counts));

// 3) A's LLM completes; B must run automatically — no second idle for B.
releaseA();
await aPromise;
await bPromise;
await settle(30);

console.log(JSON.stringify({ counts, duringBlock, afterEnqueue, llmOrder }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    const c = r.parsed.counts;
    // A ran alone while B queued (B absent from every counter at that point)
    expect(r.parsed.duringBlock).toEqual({
      query: { "sess-A": 1 },
      claim: { "sess-A": 1 },
      llm: { "sess-A": 1 },
      capture: {},
    });
    expect(r.parsed.afterEnqueue).toEqual({
      query: { "sess-A": 1 },
      claim: { "sess-A": 1 },
      llm: { "sess-A": 1 },
      capture: {},
    });
    // after release: both sessions fully consumed, each exactly once
    expect(c).toEqual({
      query: { "sess-A": 1, "sess-B": 1 },
      claim: { "sess-A": 1, "sess-B": 1 },
      llm: { "sess-A": 1, "sess-B": 1 },
      capture: { "sess-A": 1, "sess-B": 1 },
    });
    // strict serialization: A's LLM before B's
    expect(r.parsed.llmOrder).toEqual(["sess-A", "sess-B"]);
  }, 30_000);

  it("same session enqueued twice executes one DB query pass (dedup by uncaptured rows at run time)", () => {
    const r = runChild(`
mock.module(${JSON.stringify(u("src/config.js"))}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai", opencodeModel: "gpt-test",
    showAutoCaptureToasts: false, showErrorToasts: false,
  },
}));
const prompts = [
  { id: "pX", sessionId: "sess-X", messageId: "msg-X1", projectPath: "/w", content: "Do work", createdAt: 1, captured: false, claimed: false, capture_attempts: 0 },
];
const counts = { query: {}, llm: {} };
const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };
mock.module(${JSON.stringify(u("src/memory/user-prompt/user-prompt-manager.js"))}, () => ({
  userPromptManager: {
    async getUncapturedPromptsForSession(sid) { bump(counts.query, sid); return prompts.filter((p) => p.sessionId === sid && !p.captured && !p.claimed); },
    async claimPrompt(id) { const p = prompts.find((x) => x.id === id); if (!p || p.captured || p.claimed) return false; p.claimed = true; return true; },
    async recordFailedAttempt() {},
    async releaseClaim(id) { const p = prompts.find((x) => x.id === id); if (p && p.claimed && !p.captured) { p.claimed = false; return true; } return false; },
    async linkMemoryToPrompt() {},
    async markAsCaptured(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
    async deletePrompt(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
  },
}));
mock.module(${JSON.stringify(u("src/memory/client.js"))}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => ({ success: true, id: "m" }),
    close() {},
  },
}));
mock.module(${JSON.stringify(u("src/memory/tags.js"))}, () => ({
  getTags: () => ({ project: { tag: "t", displayName: "T", userName: "U", userEmail: "u@e.com", projectPath: "/w", projectName: "w" } }),
}));
mock.module(${JSON.stringify(u("src/ai/opencode-provider-loader.js"))}, () => ({
  loadOpencodeProvider: async () => ({
    isProviderConnected: () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      const sid = userPrompt.includes("Do work") ? "sess-X" : "?";
      bump(counts.llm, sid);
      return { summary: "s", type: "discussion", tags: [] };
    },
  }),
}));
const ctx = {
  client: {
    session: { messages: async () => ({ data: [
      { info: { id: "msg-X1", role: "user" }, parts: [{ type: "text", text: "Do work" }] },
      { info: { id: "ai-X1", role: "assistant" }, parts: [{ type: "text", text: "Did work" }] },
    ] }) },
    tui: { showToast: async () => ({}) },
  },
};

const { performAutoCapture } = await import(${JSON.stringify(u("src/memory/auto-capture.js"))});
// two overlapping invokes for the SAME session (burst idles pre-debounce)
const [r1, r2] = await Promise.all([
  performAutoCapture(ctx, "sess-X", "/w"),
  performAutoCapture(ctx, "sess-X", "/w"),
]);

console.log(JSON.stringify({ counts }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    // first job captures the row; second job finds zero uncaptured rows and
    // early-returns after exactly one query — no duplicate summary/LLM call
    expect(r.parsed.counts.query["sess-X"]).toBe(2); // each queued job queries once
    expect(r.parsed.counts.llm["sess-X"]).toBe(1); // but only one finds work
  }, 30_000);

  it("head-of-queue rejection does not poison the next job; the failing caller sees its error", () => {
    const r = runChild(`
mock.module(${JSON.stringify(u("src/config.js"))}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai", opencodeModel: "gpt-test",
    showAutoCaptureToasts: false, showErrorToasts: false,
  },
}));
const prompts = [
  { id: "pA", sessionId: "sess-A", messageId: "msg-A1", projectPath: "/w", content: "Will fail", createdAt: 1, captured: false, claimed: false, capture_attempts: 0 },
  { id: "pB", sessionId: "sess-B", messageId: "msg-B1", projectPath: "/w", content: "Will pass", createdAt: 2, captured: false, claimed: false, capture_attempts: 0 },
];
const captured = [];
mock.module(${JSON.stringify(u("src/memory/user-prompt/user-prompt-manager.js"))}, () => ({
  userPromptManager: {
    async getUncapturedPromptsForSession(sid) { return prompts.filter((p) => p.sessionId === sid && !p.captured && !p.claimed); },
    async claimPrompt(id) { const p = prompts.find((x) => x.id === id); if (!p || p.captured || p.claimed) return false; p.claimed = true; return true; },
    async recordFailedAttempt() {},
    async releaseClaim(id) { const p = prompts.find((x) => x.id === id); if (p && p.claimed && !p.captured) { p.claimed = false; return true; } return false; },
    async linkMemoryToPrompt() {},
    async markAsCaptured(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
    async deletePrompt(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
    async getUncapturedPrompts() { return []; },
  },
}));
mock.module(${JSON.stringify(u("src/memory/client.js"))}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (_c, _t, metadata) => { captured.push(metadata.sessionID); return { success: true, id: "m" }; },
    close() {},
  },
}));
mock.module(${JSON.stringify(u("src/memory/tags.js"))}, () => ({
  getTags: () => ({ project: { tag: "t", displayName: "T", userName: "U", userEmail: "u@e.com", projectPath: "/w", projectName: "w" } }),
}));
mock.module(${JSON.stringify(u("src/ai/opencode-provider-loader.js"))}, () => ({
  loadOpencodeProvider: async () => ({
    isProviderConnected: () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      if (userPrompt.includes("Will fail")) throw new Error("llm exploded");
      return { summary: "ok", type: "discussion", tags: [] };
    },
  }),
}));
const messagesFor = {
  "sess-A": [
    { info: { id: "msg-A1", role: "user" }, parts: [{ type: "text", text: "Will fail" }] },
    { info: { id: "ai-A1", role: "assistant" }, parts: [{ type: "text", text: "partial" }] },
  ],
  "sess-B": [
    { info: { id: "msg-B1", role: "user" }, parts: [{ type: "text", text: "Will pass" }] },
    { info: { id: "ai-B1", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
  ],
};
const ctxFor = (sid) => ({
  client: {
    session: { messages: async ({ path }) => ({ data: messagesFor[path.id] ?? [] }) },
    tui: { showToast: async () => ({}) },
  },
});

const { performAutoCapture } = await import(${JSON.stringify(u("src/memory/auto-capture.js"))});

// A runs first and its whole capturePrompt path swallows errors internally
// (old semantics), so it resolves; B behind it must still run to completion.
const aPromise = performAutoCapture(ctxFor("sess-A"), "sess-A", "/w");
const bPromise = performAutoCapture(ctxFor("sess-B"), "sess-B", "/w");
await Promise.all([aPromise, bPromise]);

// A prompt-manager query that THROWS (e.g. DB failure) must reject its own
// caller's promise — errors are not swallowed by the queue — while the next
// job still runs.
mock.module(${JSON.stringify(u("src/memory/user-prompt/user-prompt-manager.js"))}, () => ({
  userPromptManager: {
    async getUncapturedPromptsForSession(sid) { if (sid === "sess-C") throw new Error("db down"); return []; },
    async claimPrompt() { return true; },
    async recordFailedAttempt() {},
    async releaseClaim() { return true; },
    async linkMemoryToPrompt() {},
    async markAsCaptured() {},
    async deletePrompt() {},
  },
}));
const dPromise = performAutoCapture(ctxFor("sess-C"), "sess-C", "/w");
const ePromise = performAutoCapture(ctxFor("sess-B"), "sess-B", "/w");
const dError = await dPromise.then(() => "resolved", (e) => String(e.message));
await ePromise;

console.log(JSON.stringify({ captured, dError }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    // queue not poisoned: B captured even though A's LLM threw
    expect(r.parsed.captured).toEqual(["sess-B"]);
    // the DB-failure job rejected to ITS caller with the real error
    expect(r.parsed.dError).toBe("db down");
  }, 30_000);
});

describe("abort-signal support (dispose cancels queued-not-started jobs)", () => {
  it("queued B aborted before start does no query/claim/model; in-flight A still completes", () => {
    const r = runChild(`
mock.module(${JSON.stringify(u("src/config.js"))}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: "openai", opencodeModel: "gpt-test",
    showAutoCaptureToasts: false, showErrorToasts: false,
  },
}));
const prompts = [
  { id: "pA", sessionId: "sess-A", messageId: "msg-A1", projectPath: "/w", content: "In flight", createdAt: 1, captured: false, claimed: false, capture_attempts: 0 },
  { id: "pB", sessionId: "sess-B", messageId: "msg-B1", projectPath: "/w", content: "Queued", createdAt: 2, captured: false, claimed: false, capture_attempts: 0 },
];
const counts = { query: {}, claim: {}, llm: {}, capture: {} };
const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };
mock.module(${JSON.stringify(u("src/memory/user-prompt/user-prompt-manager.js"))}, () => ({
  userPromptManager: {
    async getUncapturedPromptsForSession(sid) { bump(counts.query, sid); return prompts.filter((p) => p.sessionId === sid && !p.captured && !p.claimed); },
    async claimPrompt(id) { const p = prompts.find((x) => x.id === id); if (!p || p.captured || p.claimed) return false; p.claimed = true; bump(counts.claim, p.sessionId); return true; },
    async recordFailedAttempt() {},
    async releaseClaim(id) { const p = prompts.find((x) => x.id === id); if (p && p.claimed && !p.captured) { p.claimed = false; return true; } return false; },
    async linkMemoryToPrompt() {},
    async markAsCaptured(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
    async deletePrompt(id) { const p = prompts.find((x) => x.id === id); if (p) { p.captured = true; p.claimed = false; } },
  },
}));
mock.module(${JSON.stringify(u("src/memory/client.js"))}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (_c, _t, metadata) => { bump(counts.capture, metadata.sessionID); return { success: true, id: "m" }; },
    close() {},
  },
}));
mock.module(${JSON.stringify(u("src/memory/tags.js"))}, () => ({
  getTags: () => ({ project: { tag: "t", displayName: "T", userName: "U", userEmail: "u@e.com", projectPath: "/w", projectName: "w" } }),
}));
let releaseA;
const gateA = new Promise((res) => { releaseA = res; });
mock.module(${JSON.stringify(u("src/ai/opencode-provider-loader.js"))}, () => ({
  loadOpencodeProvider: async () => ({
    isProviderConnected: () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      const sid = userPrompt.includes("In flight") ? "sess-A" : "sess-B";
      bump(counts.llm, sid);
      if (sid === "sess-A") await gateA;
      return { summary: "s", type: "discussion", tags: [] };
    },
  }),
}));
const messagesFor = {
  "sess-A": [
    { info: { id: "msg-A1", role: "user" }, parts: [{ type: "text", text: "In flight" }] },
    { info: { id: "ai-A1", role: "assistant" }, parts: [{ type: "text", text: "a" }] },
  ],
  "sess-B": [
    { info: { id: "msg-B1", role: "user" }, parts: [{ type: "text", text: "Queued" }] },
    { info: { id: "ai-B1", role: "assistant" }, parts: [{ type: "text", text: "b" }] },
  ],
};
const ctxFor = (sid) => ({
  client: {
    session: { messages: async ({ path }) => ({ data: messagesFor[path.id] ?? [] }) },
    tui: { showToast: async () => ({}) },
  },
});

const { performAutoCapture } = await import(${JSON.stringify(u("src/memory/auto-capture.js"))});

// A in flight (parked on the LLM gate); B queued behind it; plugin disposes.
const aPromise = performAutoCapture(ctxFor("sess-A"), "sess-A", "/w");
await settle(30);
const controller = new AbortController();
const bPromise = performAutoCapture(ctxFor("sess-B"), "sess-B", "/w", { signal: controller.signal });
await settle(30);
controller.abort();
const afterAbort = JSON.parse(JSON.stringify(counts));
releaseA();
await aPromise;
await bPromise;
await settle(30);

console.log(JSON.stringify({ counts, afterAbort }));
`);

    expect([r.exitCode, r.stderr]).toEqual([0, ""]);
    // B was queued and aborted before start: zero query/claim/llm/capture for B
    expect(r.parsed.afterAbort.query["sess-B"] ?? 0).toBe(0);
    expect(r.parsed.counts.claim["sess-B"] ?? 0).toBe(0);
    expect(r.parsed.counts.llm["sess-B"] ?? 0).toBe(0);
    expect(r.parsed.counts.capture["sess-B"] ?? 0).toBe(0);
    // in-flight A unaffected by the abort: fully completed and persisted
    expect(r.parsed.counts.capture["sess-A"]).toBe(1);
  }, 30_000);
});
