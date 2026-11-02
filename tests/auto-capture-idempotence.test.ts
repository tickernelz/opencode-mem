import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = (path: string) => JSON.stringify(new URL(`../src/${path}`, import.meta.url).href);
const project = "opencode_project_abcdef1234567890";
const otherProject = "opencode_project_1234567890abcdef";

function scenario(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "auto-capture-idempotence-"));
  try {
    const path = join(dir, "scenario.mjs");
    writeFileSync(
      path,
      `
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
const shards = [];
const databases = new Map();
let insertions = 0, increments = 0, markdownWrites = 0, selections = 0;
const lookups = [];
function addShard(scope, hash) {
  const id = shards.length + 1;
  const shard = { id, scope, scopeHash: hash, dbPath: "shard-" + id };
  const raw = new Database(":memory:");
  raw.run("CREATE TABLE memories (id TEXT PRIMARY KEY, container_tag TEXT, content TEXT, deleted_at INTEGER)");
  databases.set(shard.dbPath, { raw, get: async (sql, args) => raw.query(sql).get(...args) });
  shards.push(shard);
  return shard;
}
mock.module(${url("services/embedding.js")}, () => ({ embeddingService: {
  embedWithTimeout: async () => new Float32Array([1,2,3])
} }));
mock.module(${url("services/turso/ready.js")}, () => ({ ensureTursoReady: async () => {} }));
mock.module(${url("services/turso/shard-manager.js")}, () => ({ tursoShardManager: {
  withScopeWriteLock: async (_s, _h, fn) => fn(),
  getAllShards: async (scope, hash) => {
    lookups.push({scope, hash});
    return shards.filter(s => s.scope === scope && s.scopeHash === hash);
  },
  getWriteShard: async (scope, hash) => {
    selections++;
    return shards.filter(s => s.scope === scope && s.scopeHash === hash).at(-1) ?? addShard(scope, hash);
  },
  incrementVectorCount: async () => { increments++; }
} }));
mock.module(${url("services/turso/connection-manager.js")}, () => ({ tursoConnectionManager: {
  getConnection: async (path) => databases.get(path)
} }));
mock.module(${url("services/turso/vector-search.js")}, () => ({ tursoVectorSearch: {
  insertVector: async (db, record) => {
    db.raw.run("INSERT INTO memories (id, container_tag, content) VALUES (?, ?, ?)", [record.id, record.containerTag, record.content]);
    insertions++;
  }
} }));
mock.module(${url("services/markdown/backend.js")}, () => ({
  isMarkdownBackend: () => true,
  writeMemoryMarkdownFile: () => { markdownWrites++; }
}));
mock.module(${url("config.js")}, () => ({ CONFIG: {} }));
mock.module(${url("services/logger.js")}, () => ({
  log: () => {}, safeLog: () => {}, serializeError: e => ({error: String(e)})
}));
const { LocalMemoryClient } = await import(${url("services/client.js")});
let client = new LocalMemoryClient();
const tag = ${JSON.stringify(project)};
const otherTag = ${JSON.stringify(otherProject)};
const capture = promptId => ({source: "auto-capture", promptId});
${body}
`
    );
    const result = Bun.spawnSync({ cmd: [process.execPath, path], stdout: "pipe", stderr: "pipe" });
    expect(Buffer.from(result.stderr).toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(Buffer.from(result.stdout).toString().trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("auto-capture addMemory replay", () => {
  it("reuses the first insert despite a different replay summary and new client", () => {
    const result = scenario(`
const first = await client.addMemory("first summary", tag, capture("prompt-a"));
client = new LocalMemoryClient();
const second = await client.addMemory("different summary", tag, capture("prompt-a"));
console.log(JSON.stringify({first, second, insertions, increments, markdownWrites, selections}));
`);
    expect(result.first.success).toBe(true);
    expect(result.second).toEqual(result.first);
    expect(result.insertions).toBe(1);
    expect(result.increments).toBe(1);
    expect(result.markdownWrites).toBe(1);
    expect(result.selections).toBe(1);
  });

  it("keeps different prompts and projects distinct with exact scoped lookups", () => {
    const result = scenario(`
const a = await client.addMemory("same", tag, capture("a"));
const b = await client.addMemory("same", tag, capture("b"));
const c = await client.addMemory("same", otherTag, capture("a"));
console.log(JSON.stringify({ids:[a.id,b.id,c.id], insertions, lookups}));
`);
    expect(new Set(result.ids).size).toBe(3);
    expect(result.insertions).toBe(3);
    expect(result.lookups).toEqual([
      { scope: "project", hash: "abcdef1234567890" },
      { scope: "project", hash: "abcdef1234567890" },
      { scope: "project", hash: "1234567890abcdef" },
    ]);
  });

  it("does not alter manual, API, import or missing-prompt insertion semantics", () => {
    const result = scenario(`
const ids = [];
for (const source of ["manual", "api", "import", "auto-capture"]) {
  const metadata = source === "auto-capture" ? {source, promptId:""} : {source, promptId:"a"};
  ids.push((await client.addMemory("same", tag, metadata)).id);
  ids.push((await client.addMemory("same", tag, metadata)).id);
}
console.log(JSON.stringify({ids, insertions, lookups}));
`);
    expect(new Set(result.ids).size).toBe(8);
    expect(result.insertions).toBe(8);
    expect(result.lookups).toEqual([]);
  });

  it("finds older rotated shards and never resurrects a soft-deleted memory", () => {
    const result = scenario(`
const first = await client.addMemory("original", tag, capture("a"));
const older = shards[0];
databases.get(older.dbPath).raw.run("UPDATE memories SET deleted_at = 123 WHERE id = ?", [first.id]);
addShard("project", "abcdef1234567890");
const second = await client.addMemory("replay", tag, capture("a"));
const retained = databases.get(older.dbPath).raw.query("SELECT content, deleted_at FROM memories WHERE id = ?").get(first.id);
console.log(JSON.stringify({first, second, retained, insertions, increments, markdownWrites, selections}));
`);
    expect(result.second).toEqual(result.first);
    expect(result.retained).toEqual({ content: "original", deleted_at: 123 });
    expect(result.insertions).toBe(1);
    expect(result.increments).toBe(1);
    expect(result.markdownWrites).toBe(1);
    expect(result.selections).toBe(1);
  });
});
