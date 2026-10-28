import { mock } from "bun:test";
import { join } from "node:path";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const projectHash = "abcdef1234567890";
const projectTag = "opencode_project_" + projectHash;
const sessionID = "current-session";
const config = {
  storagePath: process.argv[2],
  databaseEncryptionEnabled: false,
  tursoMultiprocessWal: false,
  injectProfile: true,
  chatMessage: {
    enabled: true,
    injectOn: "always",
    maxMemories: 3,
    excludeCurrentSession: true,
    filterInjectedPrompts: true,
  },
  compaction: { enabled: false },
  autoCaptureEnabled: false,
  webServerEnabled: false,
  autoUpdate: { enabled: false },
  opencodeModel: "inherit",
};
const shards = [0, 1].map((index) => ({
  id: index + 1,
  scope: "project",
  scopeHash: projectHash,
  shardIndex: index,
  dbPath: join(config.storagePath, "shard-" + index + ".db"),
}));
mock.module(moduleUrl("config"), () => ({
  CONFIG: config,
  initConfig() {},
  isConfigured: () => true,
}));
mock.module(moduleUrl("services/embedding"), () => ({
  EmbeddingService: class {},
  embeddingService: { isWarmedUp: true, warmup: async () => {} },
}));
mock.module(moduleUrl("services/turso/ready"), () => ({
  ensureTursoReady: async () => {},
  resetTursoReady() {},
}));
mock.module(moduleUrl("services/turso/shard-manager"), () => ({
  tursoShardManager: {
    getAllShards: async (scope, hash) =>
      scope === "project" && hash === projectHash ? shards : [],
    ensureShardSchema: async () => {},
    reset() {},
  },
}));
mock.module(moduleUrl("services/tags"), () => ({
  getTags: () => ({
    project: { tag: projectTag },
    user: { userEmail: "fixture-user" },
  }),
}));
mock.module(moduleUrl("services/user-profile/profile-context"), () => ({
  getUserProfileContext: async () => "Synthetic profile preference",
}));
mock.module(moduleUrl("services/user-prompt/user-prompt-manager"), () => ({
  userPromptManager: {
    savePrompt: async () => {},
    setPromptModel: async () => {},
    reset() {},
  },
}));
mock.module(moduleUrl("services/logger"), () => ({
  log() {},
  safeLog() {},
  serializeError: (error) => ({ error: String(error) }),
}));
mock.module(moduleUrl("services/web-server"), () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(moduleUrl("services/auto-update"), () => ({ startAutoUpdate() {} }));
globalThis.fetch = () => {
  throw new Error("Network access is not allowed in this fixture");
};

// Exercise the real client, native Turso queries, schema, formatter, and plugin.
// Only host services, provider calls, and shard discovery are replaced.
const { tursoConnectionManager } = await import(moduleUrl("services/turso/connection-manager"));
const { applySchemaMigrations, memoryShardMigrations } = await import(
  moduleUrl("services/turso/schema-migrations")
);
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
const now = Date.now();
const realNow = Date.now;
Date.now = () => now;
async function add(id, age, session, shard = 0, options = {}) {
  const sessionColumn =
    "sessionColumn" in options ? options.sessionColumn : options.legacy ? null : (session ?? null);
  await databases[shard].execute(
    `INSERT INTO memories (id, content, vector, container_tag, created_at, updated_at, metadata, session_id, is_pinned)
     VALUES (?, ?, vector32('[1,0]'), ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      options.containerTag ?? projectTag,
      now - age,
      now - age,
      "metadata" in options
        ? options.metadata
        : session
          ? JSON.stringify({ sessionID: session })
          : null,
      sessionColumn,
      options.pinned ? 1 : 0,
    ]
  );
}
async function clear() {
  for (const db of databases) await db.execute("DELETE FROM memories");
  readSizes.length = 0;
}
for (let i = 0; i < 3; i++) await add("excluded-" + i, i, sessionID);
for (let i = 0; i < 3; i++) await add("eligible-" + i, 100 + i, "earlier-session");
const { OpenCodeMemPlugin } = await import(moduleUrl("index"));
const { memoryClient } = await import(moduleUrl("services/client"));
const plugin = await OpenCodeMemPlugin({
  directory: "/fixture-project",
  client: {
    provider: { list: async () => ({ data: { connected: [] } }) },
    session: {
      messages: async () => ({ data: [] }),
      get: async () => ({ data: { title: "regular task" } }),
    },
  },
});
const ids = (text) =>
  Array.from(text.matchAll(/<memory\b[^>]*\bid="([^"]+)"/g), (match) => match[1]);
const loaded = await plugin.memoryContext.load(sessionID);
const message = {
  message: { id: "fixture-message" },
  parts: [{ type: "text", text: "A real user request" }],
};
await plugin["chat.message"]({ sessionID }, message);
const result = {
  loaded: ids(loaded),
  v1: ids(
    message.parts
      .filter((part) => part.synthetic)
      .map((part) => part.text)
      .join("\n")
  ),
  readSizes: [...readSizes],
};
result.ordinaryList = (await memoryClient.listMemories(projectTag, 3)).memories.map((m) => m.id);
config.chatMessage.excludeCurrentSession = false;
result.unfiltered = ids(await plugin.memoryContext.load(sessionID));
config.chatMessage.excludeCurrentSession = true;

// Eligibility must precede both per-shard limits and the merged result limit.
await clear();
config.chatMessage.maxAgeDays = 1;
await add("expired-pinned", 2 * 86400000, undefined, 0, { pinned: true });
await add("current-pinned", 0, sessionID, 0, { pinned: true });
await add("other-project", 0, undefined, 0, { containerTag: "opencode_project_other" });
await add("eligible-a", 100, undefined);
await add("eligible-b", 300, "older-session");
await add("eligible-c", 200, undefined, 1);
await add("eligible-d", 400, undefined, 1);
result.multishard = ids(await plugin.memoryContext.load(sessionID));
result.multishardReadSizes = [...readSizes];

// Preserve the strict age cutoff, even when an older pinned row is ahead of it.
await clear();
await add("too-old-pinned", 86400001, undefined, 0, { pinned: true });
await add("cutoff", 86400000);
await add("recent", 100);
result.ageFiltered = ids(await plugin.memoryContext.load(sessionID));
config.chatMessage.maxAgeDays = 0;
result.ageDisabled = ids(await plugin.memoryContext.load(sessionID));

// Preserve per-shard pinned candidate selection and merged recency ordering.
await clear();
await add("pinned", 1000, undefined, 0, { pinned: true });
for (let i = 0; i < 4; i++) await add("recent-" + i, i);
result.pinned = ids(await plugin.memoryContext.load(sessionID));

// Across shards, pins must survive the merged limit (not only per-shard ORDER BY).
await clear();
await add("cross-pinned", 5000, undefined, 0, { pinned: true });
await add("shard0-recent", 40, undefined, 0);
await add("shard1-newer", 10, undefined, 1);
await add("shard1-newest", 0, undefined, 1);
result.crossPinned = ids(await plugin.memoryContext.load(sessionID));

// Session exclusion prefers session_id, then metadata.sessionID for legacy rows.
await clear();
await add("legacy-current", 0, sessionID, 0, { legacy: true });
await add("malformed", 10, undefined, 0, { metadata: "not-json" });
await add("missing-metadata", 20, sessionID, 0, { metadata: null });
await add("session-column-only", 25, undefined, 0, {
  metadata: null,
  sessionColumn: sessionID,
});
await add("different-session", 30, sessionID + "-suffix");
result.metadata = ids(await plugin.memoryContext.load(sessionID));

await clear();
await add("current", 0, sessionID);
await add("only-eligible", 100);
result.fewer = ids(await plugin.memoryContext.load(sessionID));
config.chatMessage.maxMemories = 0;
result.zero = await plugin.memoryContext.load(sessionID);
config.chatMessage.maxMemories = 3;
await clear();
await add("current", 0, sessionID);
result.none = await plugin.memoryContext.load(sessionID);
Date.now = realNow;
await plugin.dispose();
await tursoConnectionManager.closeAll();
console.log(JSON.stringify(result));
