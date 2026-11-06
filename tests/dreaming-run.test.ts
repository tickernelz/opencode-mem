import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const configUrl = new URL("../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/services/turso/connection-manager.js", import.meta.url)
  .href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;
const vectorUtilsUrl = new URL("../src/services/turso/vector-utils.js", import.meta.url).href;
const opencodeProviderUrl = new URL("../src/services/ai/opencode-provider.js", import.meta.url)
  .href;
const dreamingLockUrl = new URL("../src/services/dreaming-lock.js", import.meta.url).href;
const dreamingServiceUrl = new URL("../src/services/dreaming-service.js", import.meta.url).href;
const apiHandlersUrl = new URL("../src/services/api-handlers.js", import.meta.url).href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;

function runFixture(scriptBody: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
} {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-dreaming-run-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  writeFileSync(scriptPath, scriptBody);
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

describe("dreaming run API mapping", () => {
  function apiMappingFixture(opts: {
    runError?: string;
    runResult?: Record<string, number>;
    dreamingEnabled?: boolean;
  }): string {
    const storageDir = mkdtempSync(join(tmpdir(), "dream-api-map-"));
    tempDirs.push(storageDir);
    const promptManagerUrl = new URL(
      "../src/services/user-prompt/user-prompt-manager.js",
      import.meta.url
    ).href;
    const enabled = opts.dreamingEnabled !== false;
    const runImpl = opts.runError
      ? `async () => { throw new Error(${JSON.stringify(opts.runError)}); }`
      : `async () => (${JSON.stringify(opts.runResult ?? { groupsConsidered: 0, groupsMerged: 0, groupsSkipped: 0, groupsFailed: 0, groupsFlagged: 0, memoriesSoftDeleted: 0 })})`;
    return `
import { mock } from "bun:test";
import { mkdirSync } from "node:fs";

const storagePath = ${JSON.stringify(storageDir)};
mkdirSync(storagePath, { recursive: true });

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { storagePath, dreaming: { enabled: ${enabled} } },
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
  safeLog: () => {},
  serializeError: (e) => ({ error: String(e) }),
}));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {},
}));
mock.module(${JSON.stringify(dreamingServiceUrl)}, () => ({
  dreamingService: {
    run: ${runImpl},
    getStatus: () => ({ isRunning: false, enabled: ${enabled} }),
  },
}));

const { handleRunDreaming } = await import(${JSON.stringify(apiHandlersUrl)});
const out = await handleRunDreaming();
console.log(JSON.stringify(out));
`;
  }

  it("maps concurrent runs to already_running", () => {
    const result = runFixture(apiMappingFixture({ runError: "Dreaming already running" }));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ success: false, error: "already_running" });
  });

  it("maps missing provider to dreaming_provider_unavailable", () => {
    const result = runFixture(apiMappingFixture({ runError: "dreaming_provider_unavailable" }));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ success: false, error: "dreaming_provider_unavailable" });
  });

  it("allows manual run when dreaming.enabled is false (issue #491)", () => {
    const result = runFixture(
      apiMappingFixture({
        dreamingEnabled: false,
        runResult: {
          groupsConsidered: 1,
          groupsMerged: 1,
          groupsSkipped: 0,
          groupsFailed: 0,
          groupsFlagged: 0,
          memoriesSoftDeleted: 1,
        },
      })
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({
      success: true,
      data: {
        groupsConsidered: 1,
        groupsMerged: 1,
        groupsSkipped: 0,
        groupsFailed: 0,
        groupsFlagged: 0,
        memoriesSoftDeleted: 1,
      },
    });
  });
});

describe("dreaming service groupsFailed", () => {
  it("counts LLM failures as groupsFailed not groupsSkipped", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "dream-groups-failed-"));
    tempDirs.push(storageDir);
    const vecA = JSON.stringify([1, 0, 0, 0]);
    const vecB = JSON.stringify([0.99, 0.01, 0, 0]);
    const result = runFixture(`
import { mock } from "bun:test";
import { mkdirSync } from "node:fs";

const storagePath = ${JSON.stringify(storageDir)};
mkdirSync(storagePath, { recursive: true });

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    storagePath,
    opencodeProvider: "openai",
    opencodeModel: "gpt-test",
    dreaming: {
      enabled: true,
      maxGroupsPerRun: 5,
      relatedThreshold: 0.5,
      crossProject: false,
      trashRetentionDays: 30,
      intervalHours: 24,
    },
    memory: { defaultScope: "project" },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
  safeLog: () => {},
  serializeError: (e) => ({ error: String(e) }),
}));

mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: async () => {},
}));

mock.module(${JSON.stringify(dreamingLockUrl)}, () => ({
  tryAcquireDreamingLock: () => () => {},
}));

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {},
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    getAllShards: async (kind) =>
      kind === "project" ? [{ id: "p1", dbPath: "/tmp/p1.db" }] : [],
  },
}));

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    getConnection: async () => ({}),
  },
}));

mock.module(${JSON.stringify(vectorUtilsUrl)}, () => ({
  parseExtractedVector: (json) => {
    const arr = JSON.parse(String(json));
    return new Float32Array(arr);
  },
  formatTagsForEmbedding: (t) => t,
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
    getAllMemoriesWithExtractedVectors: async () => [
      {
        id: "a",
        content: "alpha fact",
        container_tag: "proj_x",
        created_at: 1,
        is_pinned: 0,
        vector_json: ${JSON.stringify(vecA)},
      },
      {
        id: "b",
        content: "alpha fact again",
        container_tag: "proj_x",
        created_at: 2,
        is_pinned: 0,
        vector_json: ${JSON.stringify(vecB)},
      },
    ],
  },
}));

mock.module(${JSON.stringify(opencodeProviderUrl)}, () => ({
  getV2Client: () => ({ session: {} }),
  generateStructuredOutput: async () => {
    throw new Error("DEEPSEEK_API_KEY is not set");
  },
}));

const { DreamingService } = await import(${JSON.stringify(dreamingServiceUrl)});
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const service = new DreamingService();
const out = await service.run();
const statePath = join(storagePath, "dreaming-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
console.log(JSON.stringify({ out, state }));
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const parsed = result.parsed as {
      out: {
        groupsConsidered: number;
        groupsFailed: number;
        groupsSkipped: number;
        groupsMerged: number;
      };
      state: { lastRunAt: number } | null;
    };
    expect(parsed.out.groupsConsidered).toBeGreaterThanOrEqual(1);
    expect(parsed.out.groupsFailed).toBe(parsed.out.groupsConsidered);
    expect(parsed.out.groupsSkipped).toBe(0);
    expect(parsed.out.groupsMerged).toBe(0);
    // Total provider failure must not advance the idle schedule.
    expect(parsed.state).toBeNull();
  });

  it("falls back to external API when opencode returns empty structured output (issue #493)", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "dream-fallback-"));
    tempDirs.push(storageDir);
    const factoryUrl = new URL("../src/services/ai/ai-provider-factory.js", import.meta.url).href;
    const providerConfigUrl = new URL("../src/services/ai/provider-config.js", import.meta.url)
      .href;
    const result = runFixture(`
import { mock } from "bun:test";

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    storagePath: ${JSON.stringify(storageDir)},
    opencodeProvider: "deepseek",
    opencodeModel: "deepseek-flash",
    opencodeVariant: "low",
    memoryProvider: "openai-chat",
    memoryModel: "deepseek-flash",
    memoryApiUrl: "https://example.test/v1",
    autoCaptureProviderOrder: "opencode-first",
    dreaming: {
      enabled: true,
      maxGroupsPerRun: 5,
      relatedThreshold: 0.5,
      crossProject: false,
      trashRetentionDays: 30,
      intervalHours: 24,
    },
    memory: { defaultScope: "project" },
  },
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
  safeLog: () => {},
  serializeError: (e) => ({ error: String(e) }),
}));

const calls = [];
mock.module(${JSON.stringify(opencodeProviderUrl)}, () => ({
  getV2Client: () => ({ session: {} }),
  generateStructuredOutput: async (opts) => {
    calls.push({ channel: "opencode", variant: opts.variant ?? null });
    throw new Error(
      "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
    );
  },
}));
mock.module(${JSON.stringify(providerConfigUrl)}, () => ({
  buildMemoryProviderConfig: () => ({ model: "deepseek-flash", apiUrl: "https://example.test/v1" }),
}));
mock.module(${JSON.stringify(factoryUrl)}, () => ({
  AIProviderFactory: {
    createProvider: () => ({
      executeToolCall: async () => {
        calls.push({ channel: "external" });
        return {
          success: true,
          data: { action: "keep", reason: "external ok" },
        };
      },
    }),
  },
}));

const { decideDreamingAction } = await import(${JSON.stringify(dreamingServiceUrl)});
const decision = await decideDreamingAction({
  representative: {
    id: "a",
    content: "alpha",
    containerTag: "proj",
    createdAt: 1,
    isPinned: false,
    scope: "project",
  },
  duplicates: [
    {
      id: "b",
      content: "alpha again",
      similarity: 0.95,
      isPinned: false,
      containerTag: "proj",
      createdAt: 2,
    },
  ],
});
console.log(JSON.stringify({ decision, calls }));
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const parsed = result.parsed as {
      decision: { action: string };
      calls: Array<{ channel: string; variant?: string | null }>;
    };
    expect(parsed.decision.action).toBe("keep");
    // Empty structured output → retry without variant, then external fallback.
    expect(parsed.calls).toEqual([
      { channel: "opencode", variant: "low" },
      { channel: "opencode", variant: null },
      { channel: "external" },
    ]);
  });

  it("retries without variant then succeeds without needing external (issue #493)", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "dream-retry-"));
    tempDirs.push(storageDir);
    const result = runFixture(`
import { mock } from "bun:test";

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    storagePath: ${JSON.stringify(storageDir)},
    opencodeProvider: "deepseek",
    opencodeModel: "deepseek-flash",
    opencodeVariant: "low",
    memoryModel: "deepseek-flash",
    memoryApiUrl: "https://example.test/v1",
    memoryProvider: "openai-chat",
    autoCaptureProviderOrder: "opencode-first",
    dreaming: {
      enabled: true,
      maxGroupsPerRun: 5,
      relatedThreshold: 0.5,
      crossProject: false,
      trashRetentionDays: 30,
      intervalHours: 24,
    },
    memory: { defaultScope: "project" },
  },
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
  safeLog: () => {},
  serializeError: (e) => ({ error: String(e) }),
}));

const calls = [];
mock.module(${JSON.stringify(opencodeProviderUrl)}, () => ({
  getV2Client: () => ({ session: {} }),
  generateStructuredOutput: async (opts) => {
    calls.push({ variant: opts.variant ?? null });
    if (opts.variant) {
      throw new Error(
        "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
      );
    }
    return { action: "keep", reason: "retry ok" };
  },
}));

const { decideDreamingAction } = await import(${JSON.stringify(dreamingServiceUrl)});
const decision = await decideDreamingAction({
  representative: {
    id: "a",
    content: "alpha",
    containerTag: "proj",
    createdAt: 1,
    isPinned: false,
    scope: "project",
  },
  duplicates: [
    {
      id: "b",
      content: "alpha again",
      similarity: 0.95,
      isPinned: false,
      containerTag: "proj",
      createdAt: 2,
    },
  ],
});
console.log(JSON.stringify({ decision, calls }));
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const parsed = result.parsed as {
      decision: { action: string };
      calls: Array<{ variant: string | null }>;
    };
    expect(parsed.decision.action).toBe("keep");
    expect(parsed.calls).toEqual([{ variant: "low" }, { variant: null }]);
  });

  it("throws when already running", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "dream-busy-"));
    tempDirs.push(storageDir);
    const result = runFixture(`
import { mock } from "bun:test";
import { mkdirSync } from "node:fs";

const storagePath = ${JSON.stringify(storageDir)};
mkdirSync(storagePath, { recursive: true });

let releaseReady;
const readyGate = new Promise((resolve) => {
  releaseReady = resolve;
});

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    storagePath,
    opencodeProvider: "openai",
    opencodeModel: "gpt-test",
    dreaming: {
      enabled: true,
      maxGroupsPerRun: 5,
      relatedThreshold: 0.9,
      crossProject: false,
      trashRetentionDays: 30,
      intervalHours: 24,
    },
    memory: { defaultScope: "project" },
  },
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {}, safeLog: () => {}, serializeError: (e) => ({ error: String(e) }) }));
mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: () => readyGate,
}));
mock.module(${JSON.stringify(dreamingLockUrl)}, () => ({
  tryAcquireDreamingLock: () => () => {},
}));
mock.module(${JSON.stringify(embeddingUrl)}, () => ({ embeddingService: {} }));
mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: { getAllShards: async () => [] },
}));
mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: { getConnection: async () => ({}) },
}));
mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: { getAllMemoriesWithExtractedVectors: async () => [] },
}));
mock.module(${JSON.stringify(vectorUtilsUrl)}, () => ({
  parseExtractedVector: () => null,
  formatTagsForEmbedding: (t) => t,
}));
mock.module(${JSON.stringify(opencodeProviderUrl)}, () => ({
  getV2Client: () => null,
  generateStructuredOutput: async () => ({}),
}));

const { DreamingService } = await import(${JSON.stringify(dreamingServiceUrl)});
const service = new DreamingService();
const first = service.run();
await new Promise((r) => setTimeout(r, 20));
let secondError = null;
try {
  await service.run();
} catch (e) {
  secondError = e instanceof Error ? e.message : String(e);
}
releaseReady();
await first;
console.log(JSON.stringify({ secondError }));
`);
    expect(result.exitCode).toBe(0);
    expect((result.parsed as { secondError: string }).secondError).toBe("Dreaming already running");
  });
});
