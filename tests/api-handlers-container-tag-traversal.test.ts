import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const apiHandlersUrl = new URL("../src/services/api-handlers.js", import.meta.url).href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/services/turso/connection-manager.js", import.meta.url)
  .href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;
const userPromptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-container-tag-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const writeShardCalls = [];

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array([1, 2, 3]),
  },
}));

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    getConnection: async () => ({}),
    closeAll: async () => {},
  },
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    async withScopeWriteLock(_scope, _hash, operation) {
      return operation();
    },
    async getWriteShard(scope, hash) {
      writeShardCalls.push({ scope, hash });
      return { id: 1, scope, scopeHash: hash, shardIndex: 0, dbPath: "/tmp/shard.db" };
    },
    async getAllShards() {
      return [];
    },
    async incrementVectorCount() {},
  },
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
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

const { handleAddMemory } = await import(${JSON.stringify(apiHandlersUrl)});
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("handleAddMemory containerTag path safety", () => {
  it("rejects a containerTag whose hash segment contains path traversal sequences", () => {
    const result = runScenario(`
const addResult = await handleAddMemory({
  content: "hello",
  containerTag: "project_x_../../../../Temp/pwn",
});
console.log(JSON.stringify({ addResult, writeShardCalls }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.addResult.success).toBe(false);
    // The shard/connection layer must never be reached with the malicious tag.
    expect(result.parsed.writeShardCalls.length).toBe(0);
  });

  it("rejects a containerTag whose hash segment contains a path separator", () => {
    const result = runScenario(`
const addResult = await handleAddMemory({
  content: "hello",
  containerTag: "project_x_foo/bar",
});
console.log(JSON.stringify({ addResult, writeShardCalls }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.addResult.success).toBe(false);
    expect(result.parsed.writeShardCalls.length).toBe(0);
  });

  it("accepts a legitimate sha256-style containerTag", () => {
    const result = runScenario(`
const addResult = await handleAddMemory({
  content: "hello",
  containerTag: "mem_project_abcdef1234567890",
});
console.log(JSON.stringify({ addResult, writeShardCalls }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.addResult.success).toBe(true);
    expect(result.parsed.writeShardCalls).toEqual([{ scope: "project", hash: "abcdef1234567890" }]);
  });
});
