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
  function apiMappingFixture(runError: string): string {
    const storageDir = mkdtempSync(join(tmpdir(), "dream-api-map-"));
    tempDirs.push(storageDir);
    const promptManagerUrl = new URL(
      "../src/services/user-prompt/user-prompt-manager.js",
      import.meta.url
    ).href;
    return `
import { mock } from "bun:test";
import { mkdirSync } from "node:fs";

const storagePath = ${JSON.stringify(storageDir)};
mkdirSync(storagePath, { recursive: true });

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { storagePath, dreaming: { enabled: true } },
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
    run: async () => {
      throw new Error(${JSON.stringify(runError)});
    },
    getStatus: () => ({ isRunning: true }),
  },
}));

const { handleRunDreaming } = await import(${JSON.stringify(apiHandlersUrl)});
const out = await handleRunDreaming();
console.log(JSON.stringify(out));
`;
  }

  it("maps concurrent runs to already_running", () => {
    const result = runFixture(apiMappingFixture("Dreaming already running"));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ success: false, error: "already_running" });
  });

  it("maps missing provider to dreaming_provider_unavailable", () => {
    const result = runFixture(apiMappingFixture("dreaming_provider_unavailable"));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ success: false, error: "dreaming_provider_unavailable" });
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
const service = new DreamingService();
const out = await service.run();
console.log(JSON.stringify(out));
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const out = result.parsed as {
      groupsConsidered: number;
      groupsFailed: number;
      groupsSkipped: number;
      groupsMerged: number;
    };
    expect(out.groupsConsidered).toBeGreaterThanOrEqual(1);
    expect(out.groupsFailed).toBeGreaterThanOrEqual(1);
    expect(out.groupsSkipped).toBe(0);
    expect(out.groupsMerged).toBe(0);
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
