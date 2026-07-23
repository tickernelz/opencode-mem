import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/services/turso/connection-manager.js", import.meta.url)
  .href;
const embeddingUrl = new URL("../src/services/embedding.js", import.meta.url).href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;
const legacyMigratorUrl = new URL("../src/services/turso/legacy-migrator.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-memory-scope-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const dbByPath = new Map();

function makeShard(id) {
  return {
    id,
    scope: "project",
    scopeHash: "",
    shardIndex: 0,
    dbPath: \`/tmp/\${id}.db\`,
    vectorCount: 0,
    isActive: true,
    createdAt: Date.now(),
  };
}

function makeDb(path) {
  const rows = path.includes("shard-a")
    ? [{ id: "a", content: "A", created_at: 2, container_tag: "tag-a" }]
    : path.includes("shard-b")
      ? [{ id: "b", content: "B", created_at: 1, container_tag: "tag-b" }]
      : [{ id: "c", content: "C", created_at: 3, container_tag: "opencode_project_a1b2c3d4e5f67890" }];

  return {
    prepare(sql) {
      return {
        all(...args) {
          if (
            sql.includes("SELECT * FROM memories") &&
            sql.includes("ORDER BY created_at DESC") &&
            !sql.includes("container_tag = ?")
          ) {
            return rows;
          }
          if (sql.includes("SELECT * FROM memories") && sql.includes("container_tag = ?")) {
            const tag = args[0];
            return rows.filter((r) => r.container_tag === tag);
          }
          return rows;
        },
        get() {
          return rows[0] ?? null;
        },
        run() {},
      };
    },
    listMemories(containerTag) {
      return containerTag === "" ? rows : rows.filter((r) => r.container_tag === containerTag);
    },
    run() {},
    close() {},
  };
}

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    async getConnection(path) {
      if (!dbByPath.has(path)) {
        dbByPath.set(path, makeDb(path));
      }
      return dbByPath.get(path);
    },
    async closeAll() {},
  },
}));

mock.module(${JSON.stringify(embeddingUrl)}, () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array([1, 2, 3]),
  },
}));

mock.module(${JSON.stringify(legacyMigratorUrl)}, () => ({
  runLegacyTursoMigration: async () => {},
}));

mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: async () => {},
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    async getAllShards(scope, hash) {
      return scope === "project" && hash === ""
        ? [makeShard("shard-a"), makeShard("shard-b")]
        : [makeShard("shard-current")];
    },
    async getWriteShard() {
      return makeShard("shard-write");
    },
    async incrementVectorCount() {},
  },
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
    searchAcrossShards: async (shards) => ({
      results: shards.map((s) => ({ id: s.id, memory: s.id, similarity: 1 })),
      warnings: [],
    }),
    listMemories: async (db, containerTag) => db.listMemories(containerTag),
    insertVector: async () => {},
  },
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

describe("memory scope", () => {
  it("defaults to project scope", () => {
    const result = runScenario(`
const res = await memoryClient.listMemories("opencode_project_a1b2c3d4e5f67890", 10);
console.log(JSON.stringify(res));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.success).toBe(true);
    expect(result.parsed.memories.length).toBe(1);
  });

  it("uses config defaultScope when provided", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemories("hello", "current", "all-projects");
console.log(JSON.stringify(res));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.success).toBe(true);
    expect(result.parsed.results.length).toBe(2);
  });

  it("lets tool params override config", () => {
    const result = runScenario(`
const res = await memoryClient.listMemories("current", 10, "all-projects");
console.log(JSON.stringify(res));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.success).toBe(true);
    expect(result.parsed.memories.length).toBe(2);
  });

  it("queries across shards for all-projects", () => {
    const result = runScenario(`
const res = await memoryClient.searchMemories("hello", "current", "all-projects");
console.log(JSON.stringify({ ids: res.results.map((r) => r.id) }));
`);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ids).toEqual(["shard-a", "shard-b"]);
  });
});
