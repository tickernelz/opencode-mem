import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;
const connectionManagerUrl = new URL(
  "../src/services/turso/connection-manager.js",
  import.meta.url
).href;
const vectorUtilsUrl = new URL("../src/services/turso/vector-utils.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;

const PROJECT_TAG = "opencode_project_abcdef1234567890";

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-client-scope-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const getAllShardsCalls = [];

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array([1, 2, 3]),
  },
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    async getAllShards(scope, hash) {
      getAllShardsCalls.push({ scope, hash });
      return [{ id: 1, scope, scopeHash: hash, shardIndex: 0, dbPath: "/tmp/shard.db" }];
    },
  },
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
    listMemories: async () => [],
    searchAcrossShards: async () => ({ results: [], warnings: [] }),
  },
}));

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    getConnection: async () => ({}),
    closeAll: async () => {},
  },
}));

mock.module(${JSON.stringify(vectorUtilsUrl)}, () => ({
  formatTagsForEmbedding: (tags) => tags.join(" "),
}));

mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: async () => {},
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { maxMemories: 20, similarityThreshold: 0.5 },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
}));

const { memoryClient } = await import(${JSON.stringify(clientUrl)});
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

describe("memory client all-projects shard traversal", () => {
  it("listMemories with all-projects walks both user and project shards", () => {
    const result = runScenario(`
let n = getAllShardsCalls.length;
await memoryClient.listMemories(${JSON.stringify(PROJECT_TAG)}, 10, "all-projects");
console.log(JSON.stringify({ calls: getAllShardsCalls.slice(n) }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.calls).toEqual([
      { scope: "user", hash: "" },
      { scope: "project", hash: "" },
    ]);
  });

  it("searchMemories with all-projects walks both user and project shards", () => {
    const result = runScenario(`
let n = getAllShardsCalls.length;
await memoryClient.searchMemories("query", ${JSON.stringify(PROJECT_TAG)}, "all-projects");
console.log(JSON.stringify({ calls: getAllShardsCalls.slice(n) }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.calls).toEqual([
      { scope: "user", hash: "" },
      { scope: "project", hash: "" },
    ]);
  });

  it("listMemories with project scope walks only the current project shard", () => {
    const result = runScenario(`
let n = getAllShardsCalls.length;
await memoryClient.listMemories(${JSON.stringify(PROJECT_TAG)}, 10, "project");
console.log(JSON.stringify({ calls: getAllShardsCalls.slice(n) }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.calls).toEqual([{ scope: "project", hash: "abcdef1234567890" }]);
  });
});
