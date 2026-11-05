import { mock } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const projectHash = "abcdef1234567890";
const projectTag = "opencode_project_" + projectHash;
const config = {
  storagePath: process.argv[2],
  databaseEncryptionEnabled: false,
  tursoMultiprocessWal: false,
  memoryBackend: "database",
  chatMessage: { fileAwareRecall: true },
};
const shards = [0, 1].map((index) => ({
  id: index + 1,
  scope: "project",
  scopeHash: projectHash,
  shardIndex: index,
  dbPath: join(config.storagePath, "shard-" + index + ".db"),
}));
mock.module(moduleUrl("config"), () => ({ CONFIG: config }));
let embeddingCalls = 0;
mock.module(moduleUrl("services/embedding"), () => ({
  embeddingService: {
    embedWithTimeout: async () => {
      embeddingCalls++;
      throw new Error("File lookup must not call embeddings");
    },
  },
}));
mock.module(moduleUrl("services/turso/ready"), () => ({ ensureTursoReady: async () => {} }));
const shardRequests = [];
mock.module(moduleUrl("services/turso/shard-manager"), () => ({
  tursoShardManager: {
    getAllShards: async (scope, hash) => {
      shardRequests.push([scope, hash]);
      return scope === "project" && hash === projectHash ? shards : [];
    },
    ensureShardSchema: async () => {},
  },
}));
mock.module(moduleUrl("services/logger"), () => ({
  log() {},
  safeLog() {},
  serializeError: (error) => ({ error: String(error) }),
}));
const { tursoConnectionManager } = await import(moduleUrl("services/turso/connection-manager"));
const { applySchemaMigrations, memoryShardMigrations } = await import(
  moduleUrl("services/turso/schema-migrations")
);
const { bindFilesToMemory } = await import(moduleUrl("services/file-memory-association"));
const { memoryClient } = await import(moduleUrl("services/client"));
const observed = { version: 1, workspace: "a".repeat(64), paths: ["src/auth.ts"] };
const databases = [];
const readSizes = [];
for (const shard of shards) {
  const db = await tursoConnectionManager.getConnection(shard.dbPath);
  await applySchemaMigrations(db, memoryShardMigrations(2));
  databases.push(db);
  const all = db.all.bind(db);
  db.all = async (...args) => {
    const rows = await all(...args);
    if (args[0].includes("FROM memories")) readSizes.push(rows.length);
    return rows;
  };
}
async function add(id, options = {}) {
  const content =
    options.content ??
    `${id}: ${(options.observed ?? observed).paths.map((path) => "`" + path + "`").join(", ")}`;
  const association = bindFilesToMemory(options.observed ?? observed, content);
  const metadata =
    "metadata" in options
      ? options.metadata
      : JSON.stringify({
          source: options.source ?? "auto-capture",
          sessionID: options.session ?? "past",
          observedFiles: association,
        });
  await databases[options.shard ?? 0].run(
    `INSERT INTO memories
    (id, content, vector, container_tag, created_at, updated_at, metadata, session_id, is_pinned, deleted_at)
    VALUES (?, ?, vector32('[1,0]'), ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      content,
      options.tag ?? projectTag,
      options.createdAt ?? 1000,
      1000,
      metadata,
      options.sessionColumn ?? options.session ?? "past",
      options.pinned ? 1 : 0,
      options.deleted ? 1 : null,
    ]
  );
}
const ids = async (filters = {}, association = observed, tag = projectTag, limit = 8) => {
  const result = await memoryClient.listFileMemories(tag, association, limit, filters);
  if (!result.success) throw new Error("Unexpected lookup failure");
  return result.memories.map((row) => row.id);
};
await add("valid-new", { createdAt: 3000 });
await add("valid-old", { shard: 1, createdAt: 1000 });
await add("unrelated-file", { observed: { ...observed, paths: ["other/auth.ts"] } });
await add("similar-prefix", { observed: { ...observed, paths: ["src/auth.tsx"] } });
await add("other-workspace", { observed: { ...observed, workspace: "b".repeat(64) } });
await add("other-project", { tag: "opencode_project_1111111111111111" });
await add("deleted", { deleted: true });
await add("imported", { source: "import" });
await add("malformed", { metadata: "{broken" });
await add("absent", { metadata: null });
await add("bad-shape", {
  metadata: JSON.stringify({ source: "auto-capture", observedFiles: { ...observed, paths: {} } }),
});
await add("rewritten", {
  metadata: JSON.stringify({
    source: "auto-capture",
    observedFiles: bindFilesToMemory(observed, "previous summary for `src/auth.ts`"),
  }),
});
await add("unsafe-path", {
  metadata: JSON.stringify({
    source: "auto-capture",
    observedFiles: {
      ...bindFilesToMemory(observed, "unsafe-path: `src/auth.ts`"),
      paths: ["src/auth.ts", "../secret"],
    },
  }),
});
// Older builds attached every observed path. A valid digest alone must not make
// an incidental file eligible; the particular requested file must be named.
await add("legacy-incidental", {
  content: "Lesson about `other/auth.ts` only",
  metadata: JSON.stringify({
    source: "auto-capture",
    observedFiles: {
      ...observed,
      paths: ["src/auth.ts", "other/auth.ts"],
      contentHash: createHash("sha256").update("Lesson about `other/auth.ts` only").digest("hex"),
    },
  }),
});
await add("current-column", { sessionColumn: "current" });
await add("current-metadata", { session: "current", sessionColumn: "past" });
const eligible = await ids({ excludeSessionId: "current" });
const ageFiltered = await ids({ excludeSessionId: "current", createdAfter: 1000 });
const includingCurrent = await ids();
const one = await ids({ excludeSessionId: "current" }, observed, projectTag, 1);
const zero = await ids({}, observed, projectTag, 0);
const invalidInput = await ids({}, { ...observed, paths: ["../secret"] });
const userScope = await ids({}, observed, "opencode_user_abcdef1234567890");
const requestsBeforeMarkdown = shardRequests.length;
config.memoryBackend = "markdown";
config.markdownPath = "/synthetic-vault";
const markdown = await ids();
const markdownRead = shardRequests.length !== requestsBeforeMarkdown;
config.memoryBackend = "database";
// SQL eligibility must precede the bounded candidate LIMIT.
for (let i = 0; i < 40; i++)
  await add("current-new-" + i, { session: "current", createdAt: 5000 + i });
const afterManyExcluded = await ids({ excludeSessionId: "current" }, observed, projectTag, 1);
// Invalidated summaries may conservatively consume the bounded candidate window.
for (let i = 0; i < 40; i++)
  await add("stale-new-" + i, {
    createdAt: 8000 + i,
    metadata: JSON.stringify({
      source: "auto-capture",
      observedFiles: bindFilesToMemory(observed, "old `src/auth.ts`"),
    }),
  });
const staleWindow = await ids({ excludeSessionId: "current" }, observed, projectTag, 1);
// Exact matching must not interpret SQL LIKE wildcards in a valid filename.
await add("wildcard", { observed: { ...observed, paths: ["src/%_file.ts"] }, createdAt: 10000 });
const wildcard = await ids({}, { ...observed, paths: ["src/%_file.ts"] });
await tursoConnectionManager.closeAll();
console.log(
  JSON.stringify({
    eligible,
    ageFiltered,
    includingCurrent,
    one,
    zero,
    invalidInput,
    userScope,
    markdown,
    markdownRead,
    afterManyExcluded,
    staleWindow,
    wildcard,
    embeddingCalls,
    readSizes,
    shardRequests,
  })
);
