import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionAgent } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveSessionAgent (#236)", () => {
  it("prefers session.get().agent when available", async () => {
    const client = {
      session: {
        get: async () => ({ data: { agent: "orchestrator" } }),
        messages: async () => ({
          data: [{ info: { role: "user", agent: "build" } }],
        }),
      },
    };

    await expect(resolveSessionAgent(client, "ses-1")).resolves.toBe("orchestrator");
  });

  it("falls back to the latest user message agent", async () => {
    const client = {
      session: {
        get: async () => ({ data: {} }),
        messages: async () => ({
          data: [
            { info: { role: "user", agent: "build" } },
            { info: { role: "assistant", mode: "build" } },
            { info: { role: "user", agent: "my-orchestrator" } },
          ],
        }),
      },
    };

    await expect(resolveSessionAgent(client, "ses-1")).resolves.toBe("my-orchestrator");
  });

  it("uses assistant mode when no user agent is present", async () => {
    const client = {
      session: {
        get: async () => ({ data: {} }),
        messages: async () => ({
          data: [
            { info: { role: "assistant", mode: "build" } },
            { info: { role: "assistant", mode: "compaction", summary: true } },
          ],
        }),
      },
    };

    await expect(resolveSessionAgent(client, "ses-1")).resolves.toBe("build");
  });

  it("skips compaction summary messages", async () => {
    const client = {
      session: {
        get: async () => ({}),
        messages: async () => ({
          data: [
            { info: { role: "user", agent: "custom-agent" } },
            { info: { role: "assistant", mode: "compaction", summary: true } },
          ],
        }),
      },
    };

    await expect(resolveSessionAgent(client, "ses-1")).resolves.toBe("custom-agent");
  });
});

const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const contextUrl = new URL("../src/services/context.js", import.meta.url).href;
const privacyUrl = new URL("../src/services/privacy.js", import.meta.url).href;
const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const learningUrl = new URL("../src/services/user-memory-learning.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const webServerUrl = new URL("../src/services/web-server.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;

function runCompactionScenario(opts: {
  memories: Array<{ memory: string; tags?: string[] }>;
  messages: Array<{ info: Record<string, unknown> }>;
  sessionAgent?: string;
  compactionEnabled?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-compaction-agent-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const promptCalls = [];

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    searchMemoriesBySessionID: async () => ({
      success: true,
      results: ${JSON.stringify(opts.memories)},
      total: ${opts.memories.length},
    }),
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    compaction: { enabled: ${opts.compactionEnabled !== false}, memoryLimit: 10 },
    autoCaptureEnabled: false,
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
mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({ performAutoCapture: async () => {} }));
mock.module(${JSON.stringify(learningUrl)}, () => ({ performUserProfileLearning: async () => {} }));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({ userPromptManager: { savePrompt() {} } }));
mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));

const mockClient = {
  session: {
    get: async () => ({ data: ${JSON.stringify({ agent: opts.sessionAgent })} }),
    messages: async () => ({ data: ${JSON.stringify(opts.messages)} }),
    prompt: async (args) => {
      promptCalls.push(args);
      return {};
    },
  },
  tui: { showToast: async () => ({}) },
};

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({ directory: "/workspace", client: mockClient });
await plugin.event({
  event: { type: "session.compacted", properties: { sessionID: "ses-1" } },
});

console.log(JSON.stringify({ promptCalls }));
`;

  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("session.compacted agent preservation (#236)", () => {
  it("passes the resolved custom agent to session.prompt", () => {
    const result = runCompactionScenario({
      sessionAgent: "my-orchestrator",
      memories: [{ memory: "remember this", tags: ["t1"] }],
      messages: [{ info: { role: "user", agent: "my-orchestrator" } }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.promptCalls).toHaveLength(1);
    expect(result.parsed?.promptCalls[0]?.body?.agent).toBe("my-orchestrator");
    expect(result.parsed?.promptCalls[0]?.body?.noReply).toBe(true);
  });

  it("marks the injected part as synthetic so it is not echoed into the transcript (follow-up to #239)", () => {
    const result = runCompactionScenario({
      sessionAgent: "my-orchestrator",
      memories: [{ memory: "remember this", tags: ["t1"] }],
      messages: [{ info: { role: "user", agent: "my-orchestrator" } }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.promptCalls).toHaveLength(1);
    expect(result.parsed?.promptCalls[0]?.body?.parts?.[0]?.synthetic).toBe(true);
  });

  it("does not call session.prompt when there are no memories", () => {
    const result = runCompactionScenario({
      sessionAgent: "my-orchestrator",
      memories: [],
      messages: [{ info: { role: "user", agent: "my-orchestrator" } }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed?.promptCalls).toEqual([]);
  });

  it("does not inject memories when the active agent cannot be resolved", () => {
    const result = runCompactionScenario({
      memories: [{ memory: "remember this" }],
      messages: [{ info: { role: "assistant", mode: "compaction", summary: true } }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed?.promptCalls).toEqual([]);
  });

  it("does nothing when compaction is disabled", () => {
    const result = runCompactionScenario({
      compactionEnabled: false,
      sessionAgent: "my-orchestrator",
      memories: [{ memory: "remember this" }],
      messages: [{ info: { role: "user", agent: "my-orchestrator" } }],
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed?.promptCalls).toEqual([]);
  });
});
