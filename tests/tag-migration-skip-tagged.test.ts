import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const apiHandlersUrl = new URL("../src/runtime/http/api-handlers.js", import.meta.url).href;
const embeddingUrl = new URL("../src/memory/embedding.js", import.meta.url).href;
const vectorUtilsUrl = new URL("../src/storage/turso/vector-utils.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/storage/turso/connection-manager.js", import.meta.url)
  .href;
const shardManagerUrl = new URL("../src/storage/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/storage/turso/vector-search.js", import.meta.url).href;
const readyUrl = new URL("../src/storage/turso/ready.js", import.meta.url).href;
const userPromptManagerUrl = new URL(
  "../src/memory/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/infra/logger.js", import.meta.url).href;
const factoryUrl = new URL("../src/ai/ai-provider-factory.js", import.meta.url).href;
const providerConfigUrl = new URL("../src/ai/provider-config.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-tag-skip-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const updateVectorCalls = [];
const updateTagCalls = [];
const embedCalls = [];

// "done1" is fully migrated (tags + tags vector); "todo1" still needs tagging.
const memories = [
  { id: "done1", content: "already done content", tags: "alpha,beta", tags_vector: new Uint8Array([1, 2, 3]) },
  { id: "todo1", content: "needs tagging", tags: null, tags_vector: null },
];

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async (text) => {
      embedCalls.push(text);
      return new Float32Array([1, 2, 3]);
    },
  },
}));

mock.module(${JSON.stringify(vectorUtilsUrl)}, () => ({
  formatTagsForEmbedding: (tags) => "Topics: " + tags.join(", "),
  parseSessionIdFromMetadata: () => null,
}));

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    getConnection: async () => ({
      all: async () => memories,
      run: async (sql, params) => {
        updateTagCalls.push({ sql, params });
      },
      get: async () => ({ count: memories.length }),
    }),
    closeAll: async () => {},
  },
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    async getAllShards() {
      return [{ id: 1, scope: "project", scopeHash: "h", shardIndex: 0, dbPath: "/tmp/shard.db" }];
    },
    async withScopeWriteLock(_scope, _hash, operation) {
      return operation();
    },
    async getWriteShard() {
      return { id: 1, scope: "project", scopeHash: "h", shardIndex: 0, dbPath: "/tmp/shard.db" };
    },
    async incrementVectorCount() {},
  },
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
    updateVector: async (_db, id) => {
      updateVectorCalls.push(id);
    },
    insertVector: async () => {},
    listMemories: async () => [],
  },
}));

mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: async () => {},
}));

mock.module(${JSON.stringify(userPromptManagerUrl)}, () => ({
  userPromptManager: {},
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { memoryProvider: "openai-chat" },
}));

mock.module(${JSON.stringify(providerConfigUrl)}, () => ({
  buildMemoryProviderConfig: () => ({}),
}));

mock.module(${JSON.stringify(factoryUrl)}, () => ({
  AIProviderFactory: {
    createProvider() {
      return {
        async executeToolCall() {
          return { success: true, data: { tags: ["generated", "tags"] } };
        },
      };
    },
  },
}));

const {
  handleRunTagMigrationBatch,
  handleGetTagMigrationProgress,
} = await import(${JSON.stringify(apiHandlersUrl)});

${scriptBody}
`;
  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{"));

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: jsonLine ? JSON.parse(jsonLine) : null,
  };
}

describe("tag migration skips already-migrated memories", () => {
  it("does not re-vectorize a memory that already has tags and a tags vector", () => {
    const result = runScenario(`
const batch = await handleRunTagMigrationBatch(5);
const progress = await handleGetTagMigrationProgress();
console.log(JSON.stringify({ batch, progress, updateVectorCalls, updateTagCalls, embedCalls }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed).not.toBeNull();

    // Both memories are accounted for, but only the untagged one is rewritten.
    expect(result.parsed.batch.data.processed).toBe(2);
    expect(result.parsed.batch.data.hasMore).toBe(false);
    expect(result.parsed.batch.data.errors).toBe(0);

    // Only the untagged memory is re-vectorized; the finished one is skipped.
    expect(result.parsed.updateVectorCalls).toEqual(["todo1"]);

    // Its content is embedded once (content) plus once (tags) — never the done memory.
    expect(result.parsed.embedCalls).toContain("needs tagging");
    expect(result.parsed.embedCalls).not.toContain("already done content");
    expect(result.parsed.embedCalls.length).toBe(2);

    // Only the untagged memory's tags are written to the database.
    expect(result.parsed.updateTagCalls.length).toBe(1);
    expect(result.parsed.updateTagCalls[0].params[1]).toBe("todo1");
  });
});
