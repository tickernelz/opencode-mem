import { beforeEach, describe, expect, it, mock } from "bun:test";

const dbByPath = new Map<string, any>();

mock.module("../src/services/sqlite/connection-manager.js", () => ({
  connectionManager: {
    getConnection(path: string) {
      if (!dbByPath.has(path)) {
        dbByPath.set(path, makeDb(path));
      }
      return dbByPath.get(path);
    },
    closeAll() {},
  },
}));

mock.module("../src/services/embedding.js", () => ({
  embeddingService: {
    isWarmedUp: true,
    warmup: async () => {},
    embedWithTimeout: async () => new Float32Array([1, 2, 3]),
  },
}));

mock.module("../src/services/sqlite/shard-manager.js", () => ({
  shardManager: {
    getAllShards(scope: string, hash: string) {
      return scope === "project" && hash === ""
        ? [makeShard("shard-a"), makeShard("shard-b")]
        : [makeShard("shard-current")];
    },
    getWriteShard() {
      return makeShard("shard-write");
    },
    incrementVectorCount() {},
  },
}));

mock.module("../src/services/sqlite/vector-search.js", () => ({
  vectorSearch: {
    searchAcrossShards: async (shards: any[]) =>
      shards.map((s) => ({ id: s.id, memory: s.id, similarity: 1 })),
    listMemories: (db: any, containerTag: string) => db.listMemories(containerTag),
    insertVector: async () => {},
  },
}));

const { memoryClient } = await import("../src/services/client.js");

function makeShard(id: string) {
  return {
    id,
    scope: "project",
    scopeHash: "",
    shardIndex: 0,
    dbPath: `/tmp/${id}.db`,
    vectorCount: 0,
    isActive: true,
    createdAt: Date.now(),
  };
}

function makeDb(path: string) {
  const rows = path.includes("shard-a")
    ? [{ id: "a", content: "A", created_at: 2, container_tag: "tag-a" }]
    : path.includes("shard-b")
      ? [{ id: "b", content: "B", created_at: 1, container_tag: "tag-b" }]
      : [{ id: "c", content: "C", created_at: 3, container_tag: "current" }];

  return {
    prepare(sql: string) {
      return {
        all(...args: any[]) {
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
    listMemories(containerTag: string) {
      return containerTag === "" ? rows : rows.filter((r) => r.container_tag === containerTag);
    },
    run() {},
    close() {},
  };
}

beforeEach(() => {
  dbByPath.clear();
});

describe("memory scope", () => {
  it("defaults to project scope", async () => {
    const res = await memoryClient.listMemories("current", 10);
    expect(res.success).toBe(true);
    expect(res.memories.length).toBe(1);
  });

  it("uses config defaultScope when provided", async () => {
    const res = await memoryClient.searchMemories("hello", "current", "all-projects");
    expect(res.success).toBe(true);
    expect(res.results.length).toBe(2);
  });

  it("lets tool params override config", async () => {
    const res = await memoryClient.listMemories("current", 10, "all-projects");
    expect(res.success).toBe(true);
    expect(res.memories.length).toBe(2);
  });

  it("queries across shards for all-projects", async () => {
    const res = await memoryClient.searchMemories("hello", "current", "all-projects");
    expect(res.results.map((r: any) => r.id)).toEqual(["shard-a", "shard-b"]);
  });
});
