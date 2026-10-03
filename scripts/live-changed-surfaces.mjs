/**
 * Exhaustive live verification of every changed surface:
 * schema, engine migrate (incl. NULL tags_vector), encryption migrate,
 * stale metadata handle, vector search after encrypt, aux DBs via managers,
 * sqlite rename helpers, package deps, config defaults.
 *
 * Run: bun scripts/live-changed-surfaces.mjs
 */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { connect } from "@tursodatabase/database";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`✔ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, error) {
  results.push({ name, ok: false, detail: String(error) });
  console.error(`✖ ${name}`);
  console.error(error);
}

const { CONFIG } = await import(join(root, "src/config.ts"));
const { resetTursoReady, ensureTursoReady } = await import(
  join(root, "src/storage/turso/ready.ts")
);
const { tursoShardManager } = await import(join(root, "src/storage/turso/shard-manager.ts"));
const { tursoConnectionManager, resolveDatabaseEncryption } = await import(
  join(root, "src/storage/turso/connection-manager.ts")
);
const { tursoVectorSearch } = await import(join(root, "src/storage/turso/vector-search.ts"));
const { runTursoEngineMigration } = await import(
  join(root, "src/storage/turso/engine-migrator.ts")
);
const { runDatabaseEncryptionMigration } = await import(
  join(root, "src/storage/turso/encryption-migrator.ts")
);
const {
  generateDatabaseEncryptionKeyFile,
  isValidDatabaseEncryptionHexKey,
  resolveOrCreateDatabaseEncryptionKey,
} = await import(join(root, "src/storage/turso/encryption-key.ts"));
const {
  applySchemaMigrations,
  USER_PROMPTS_MIGRATIONS,
  USER_PROFILES_MIGRATIONS,
  AI_SESSIONS_MIGRATIONS,
  METADATA_DB_MIGRATIONS,
  ensureUserPromptColumns,
  memoryShardMigrations,
} = await import(join(root, "src/storage/turso/schema-migrations.ts"));
const { TursoDb } = await import(join(root, "src/storage/turso/turso-db.ts"));
const { renameSqliteDatabase, copySqliteDatabase, removeSqliteDatabase } = await import(
  join(root, "src/storage/turso/sqlite-handle-release.ts")
);
const { userPromptManager } = await import(
  join(root, "src/memory/user-prompt/user-prompt-manager.ts")
);
const { userProfileManager } = await import(join(root, "src/user-profile/user-profile-manager.ts"));
const { aiSessionManager } = await import(join(root, "src/ai/session/ai-session-manager.ts"));

const SCOPE = "a1b2c3d4e5f67890";
const SCOPE2 = "b2c3d4e5f6789012";
const baseDir = mkdtempSync(join(tmpdir(), "opencode-mem-changed-"));
const previous = {
  storagePath: CONFIG.storagePath,
  embeddingDimensions: CONFIG.embeddingDimensions,
  databaseEncryptionEnabled: CONFIG.databaseEncryptionEnabled,
  databaseEncryptionKey: CONFIG.databaseEncryptionKey,
  databaseEncryptionCipher: CONFIG.databaseEncryptionCipher,
};

async function cleanup() {
  try {
    await tursoConnectionManager.closeAll();
  } catch {
    // ignore
  }
  try {
    tursoShardManager.reset();
  } catch {
    // ignore
  }
  resetTursoReady();
  Object.assign(CONFIG, previous);
  rmSync(baseDir, { recursive: true, force: true });
}

try {
  CONFIG.storagePath = baseDir;
  CONFIG.embeddingDimensions = 768;
  CONFIG.databaseEncryptionEnabled = false;
  CONFIG.databaseEncryptionKey = undefined;
  CONFIG.databaseEncryptionCipher = "aes256gcm";
  mkdirSync(join(baseDir, "projects"), { recursive: true });
  mkdirSync(join(baseDir, "users"), { recursive: true });
  mkdirSync(join(baseDir, "config"), { recursive: true });

  const dims = CONFIG.embeddingDimensions;
  const vec = (i = 0) => {
    const v = new Float32Array(dims);
    v[i] = 1;
    return v;
  };

  try {
    assert.equal(CONFIG.databaseEncryptionEnabled, false);
    assert.equal(CONFIG.databaseEncryptionCipher, "aes256gcm");
    assert.equal(resolveDatabaseEncryption(), null);
    pass("config", "encryption off + cipher aes256gcm");
  } catch (e) {
    fail("config", e);
  }

  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    assert.ok(pkg.dependencies["@tursodatabase/database"]);
    assert.ok(pkg.dependencies["@libsql/client"]);
    pass("package.json", `@tursodatabase/database=${pkg.dependencies["@tursodatabase/database"]}`);
  } catch (e) {
    fail("package.json", e);
  }

  try {
    for (const [label, path, migrations, ensure] of [
      [
        "user-prompts",
        join(baseDir, "user-prompts.db"),
        USER_PROMPTS_MIGRATIONS,
        ensureUserPromptColumns,
      ],
      ["user-profiles", join(baseDir, "user-profiles.db"), USER_PROFILES_MIGRATIONS, null],
      ["ai-sessions", join(baseDir, "ai-sessions.db"), AI_SESSIONS_MIGRATIONS, null],
      ["metadata", join(baseDir, "metadata-schema.db"), METADATA_DB_MIGRATIONS, null],
    ]) {
      const native = await connect(path, { experimental: ["encryption"] });
      const db = new TursoDb(native);
      const v1 = await applySchemaMigrations(db, migrations, { dbPath: path, label });
      assert.equal(v1, 1, `${label} version`);
      if (ensure) await ensure(db);
      const v2 = await applySchemaMigrations(db, migrations, { dbPath: path, label });
      assert.equal(v2, 1, `${label} idempotent`);
      await db.close();
    }
    const shardPath = join(baseDir, "projects", "schema-shard.db");
    const sn = await connect(shardPath, { experimental: ["encryption"] });
    const sdb = new TursoDb(sn);
    assert.equal(
      await applySchemaMigrations(sdb, memoryShardMigrations(dims), {
        dbPath: shardPath,
        label: "shard",
      }),
      1
    );
    await sdb.close();
    pass("schema-migrations", "prompts/profiles/sessions/metadata/shard idempotent");
  } catch (e) {
    fail("schema-migrations", e);
  }

  try {
    const src = join(baseDir, "handle-src.db");
    const dst = join(baseDir, "handle-dst.db");
    const renamed = join(baseDir, "handle-renamed.db");
    const n = await connect(src, { experimental: ["encryption"] });
    await n.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7);");
    await n.close();
    copySqliteDatabase(src, dst);
    renameSqliteDatabase(dst, renamed);
    removeSqliteDatabase(renamed);
    assert.equal(existsSync(renamed), false);
    pass("sqlite-handle-release", "copy → rename → remove");
  } catch (e) {
    fail("sqlite-handle-release", e);
  }

  try {
    resetTursoReady();
    tursoShardManager.reset();
    await ensureTursoReady();
    const primaryShard = await tursoShardManager.createShard("project", SCOPE, 0);
    const db = await tursoConnectionManager.getConnection(primaryShard.dbPath);
    await tursoVectorSearch.insertVector(db, {
      id: "mem_changed_1",
      content: "changed surfaces memory",
      vector: vec(0),
      tagsVector: vec(1),
      containerTag: `opencode_project_${SCOPE}`,
      tags: "changed,live",
      type: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: JSON.stringify({ changed: true }),
      displayName: "Changed Memory",
      projectPath: "/changed/project",
    });
    await tursoShardManager.incrementVectorCount(primaryShard.id);
    const hits = await tursoVectorSearch.searchInShard(
      primaryShard,
      vec(0),
      `opencode_project_${SCOPE}`,
      5,
      "changed"
    );
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.id, "mem_changed_1");
    pass("vector-search", `${hits.length} hit(s), similarity=${hits[0]?.similarity?.toFixed?.(3)}`);
  } catch (e) {
    fail("vector-search", e);
  }

  try {
    const promptId = await userPromptManager.savePrompt(
      "ses_live_1",
      "msg_live_1",
      "/changed/project",
      "live prompt body"
    );
    assert.equal((await userPromptManager.getPromptById(promptId))?.content, "live prompt body");

    const profileId = await userProfileManager.createProfile(
      "user_live",
      "Live User",
      "liveuser",
      "live@example.com",
      {
        preferences: [{ description: "prefers dark mode", confidence: 0.9, evidence: 1 }],
        patterns: [],
        workflows: [],
      },
      1
    );
    assert.ok(profileId.startsWith("profile_"));
    assert.equal(
      (await userProfileManager.getActiveProfile("user_live"))?.displayName,
      "Live User"
    );

    const session = await aiSessionManager.createSession({
      provider: "openai-chat",
      sessionId: "oc_ses_live_1",
      conversationId: "conv_live_1",
      metadata: { purpose: "live-changed" },
    });
    await aiSessionManager.addMessage({
      aiSessionId: session.id,
      role: "user",
      content: "hello live",
      sequence: 1,
    });
    assert.equal((await aiSessionManager.getMessages(session.id)).length, 1);
    pass("aux-managers", "user-prompt + user-profile + ai-session");
  } catch (e) {
    fail("aux-managers", e);
  }

  try {
    const legacyPath = join(baseDir, "projects", `project_${SCOPE2}_shard_0.db`);
    const client = createClient({ url: `file:${legacyPath}` });
    try {
      await client.execute(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, content TEXT NOT NULL, vector F32_BLOB(768) NOT NULL,
          tags_vector F32_BLOB(768), container_tag TEXT NOT NULL, tags TEXT, type TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT,
          display_name TEXT, user_name TEXT, user_email TEXT, project_path TEXT,
          project_name TEXT, git_repo_url TEXT, is_pinned INTEGER DEFAULT 0
        )
      `);
      const engineVec = new Array(768).fill(0);
      engineVec[2] = 1;
      await client.execute({
        sql: `INSERT INTO memories (id, content, vector, tags_vector, container_tag, created_at, updated_at)
              VALUES (?, ?, vector32(?), NULL, ?, ?, ?)`,
        args: [
          "mem_null_tags",
          "engine null tags",
          JSON.stringify(engineVec),
          `opencode_project_${SCOPE2}`,
          Date.now(),
          Date.now(),
        ],
      });
      await client.execute(
        `CREATE INDEX memories_vector_idx ON memories (libsql_vector_idx(vector))`
      );
    } finally {
      client.close();
    }

    const engineMarker = join(baseDir, ".tursodb-engine-v1");
    if (existsSync(engineMarker)) rmSync(engineMarker);
    await tursoConnectionManager.closeAll();
    tursoShardManager.reset();
    resetTursoReady();
    await runTursoEngineMigration();
    assert.ok(existsSync(engineMarker));
    const db = await tursoConnectionManager.getConnection(legacyPath);
    const row = await db.get(`SELECT id, content FROM memories WHERE id = ?`, ["mem_null_tags"]);
    assert.equal(row?.id, "mem_null_tags");
    pass("engine-migrator", "DiskANN + NULL tags_vector → tursodb");
  } catch (e) {
    fail("engine-migrator", e);
  }

  let hexkey;
  try {
    const keyPath = join(baseDir, "config", "opencode-mem-db.key");
    CONFIG.databaseEncryptionEnabled = true;
    CONFIG.databaseEncryptionKey = `file://${keyPath}`;
    hexkey = resolveOrCreateDatabaseEncryptionKey();
    assert.ok(isValidDatabaseEncryptionHexKey(hexkey));
    if (platform() !== "win32") assert.equal(statSync(keyPath).mode & 0o777, 0o600);

    await tursoConnectionManager.closeAll();
    tursoShardManager.reset();
    const encMarker = join(baseDir, ".tursodb-encrypted-v1");
    if (existsSync(encMarker)) rmSync(encMarker);
    await runDatabaseEncryptionMigration();
    assert.ok(existsSync(encMarker));
    assert.throws(
      () => generateDatabaseEncryptionKeyFile(join(baseDir, "config", "other.key")),
      /already exist/
    );

    const anyDb = readdirSync(join(baseDir, "projects")).find(
      (n) => n.endsWith(".db") && !n.includes(".bak") && !n.includes(".tmp")
    );
    assert.ok(anyDb);
    const dbPath = join(baseDir, "projects", anyDb);
    await assert.rejects(() => connect(dbPath, { experimental: ["encryption"] }));
    const enc = await connect(dbPath, {
      encryption: { cipher: "aes256gcm", hexkey },
      experimental: ["encryption"],
    });
    await enc.prepare("SELECT 1").all();
    await enc.close();

    resetTursoReady();
    tursoShardManager.reset();
    await ensureTursoReady();
    const scopeShards = await tursoShardManager.getAllShards("project", SCOPE);
    if (scopeShards[0]) {
      const hits = await tursoVectorSearch.searchInShard(
        scopeShards[0],
        vec(0),
        `opencode_project_${SCOPE}`,
        5
      );
      assert.ok(hits.length >= 1);
      assert.equal(hits[0]?.id, "mem_changed_1");
    }
    pass("encryption-migrator", "key 0600 + dump/reload + ready + search");
  } catch (e) {
    fail("encryption-migrator", e);
  }

  try {
    const opts = resolveDatabaseEncryption();
    assert.ok(opts);
    assert.equal(opts.cipher, "aes256gcm");
    assert.equal(opts.hexkey, hexkey);
    pass("connection-manager", "resolveDatabaseEncryption returns cipher+hexkey");
  } catch (e) {
    fail("connection-manager", e);
  }

  try {
    resetTursoReady();
    await ensureTursoReady();
    await ensureTursoReady();
    pass("ready-gate", "idempotent under encryption");
  } catch (e) {
    fail("ready-gate", e);
  }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log("\n==============================");
console.log(`CHANGED SURFACES: ${results.length - failed.length}/${results.length} passed`);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log("==============================");
if (failed.length) {
  process.exitCode = 1;
  console.error(`\n${failed.length} changed surface(s) FAILED`);
} else {
  console.log("\nALL CHANGED SURFACES PASSED");
}
