import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@tursodatabase/database";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";
import { TursoDb } from "../src/storage/turso/turso-db.js";

const MIGRATION_TEST_TIMEOUT = 20000;
const migrationTest = (name: string, fn: () => void | Promise<void>) =>
  it(name, fn, MIGRATION_TEST_TIMEOUT);

describe("turso encryption migrator", () => {
  let baseDir: string;
  let restoreConfig: (() => void) | undefined;

  afterEach(async () => {
    restoreConfig?.();
    restoreConfig = undefined;
    const { tursoShardManager } = await import("../src/storage/turso/shard-manager.js");
    tursoShardManager.reset();
    await cleanupTursoTestDirectory(baseDir);
  });

  async function withStorage(enabled: boolean) {
    baseDir = mkdtempSync(join(tmpdir(), "turso-encrypt-mig-"));
    mkdirSync(join(baseDir, "projects"), { recursive: true });
    mkdirSync(join(baseDir, "config"), { recursive: true });

    const { CONFIG } = await import("../src/config.js");
    const previous = {
      storagePath: CONFIG.storagePath,
      embeddingDimensions: CONFIG.embeddingDimensions,
      databaseEncryptionEnabled: CONFIG.databaseEncryptionEnabled,
      databaseEncryptionKey: CONFIG.databaseEncryptionKey,
      databaseEncryptionCipher: CONFIG.databaseEncryptionCipher,
    };
    restoreConfig = () => {
      CONFIG.storagePath = previous.storagePath;
      CONFIG.embeddingDimensions = previous.embeddingDimensions;
      CONFIG.databaseEncryptionEnabled = previous.databaseEncryptionEnabled;
      CONFIG.databaseEncryptionKey = previous.databaseEncryptionKey;
      CONFIG.databaseEncryptionCipher = previous.databaseEncryptionCipher;
    };

    CONFIG.storagePath = baseDir;
    CONFIG.embeddingDimensions = 4;
    CONFIG.databaseEncryptionEnabled = enabled;
    CONFIG.databaseEncryptionCipher = "aes256gcm";
    if (enabled) {
      CONFIG.databaseEncryptionKey = `file://${join(baseDir, "config", "opencode-mem-db.key")}`;
    } else {
      CONFIG.databaseEncryptionKey = undefined;
    }
  }

  async function createPlaintextShard(fileName: string, withAutoincrementMeta = false) {
    const dbPath = join(baseDir, "projects", fileName);
    const native = await connect(dbPath, { experimental: ["encryption"] });
    const db = new TursoDb(native);
    await db.run(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        vector F32_BLOB(4) NOT NULL,
        tags_vector F32_BLOB(4),
        container_tag TEXT NOT NULL,
        tags TEXT,
        type TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT,
        display_name TEXT,
        user_name TEXT,
        user_email TEXT,
        project_path TEXT,
        project_name TEXT,
        git_repo_url TEXT,
        is_pinned INTEGER DEFAULT 0
      )
    `);
    await db.run(
      `INSERT INTO memories (id, content, vector, tags_vector, container_tag, created_at, updated_at)
       VALUES (?, ?, vector32(?), NULL, ?, ?, ?)`,
      [
        "mem_plain",
        "encrypt me",
        "[1,0,0,0]",
        "opencode_project_a1b2c3d4e5f67890",
        Date.now(),
        Date.now(),
      ]
    );
    await db.close();

    if (withAutoincrementMeta) {
      const metaPath = join(baseDir, "metadata.db");
      const metaNative = await connect(metaPath, { experimental: ["encryption"] });
      const meta = new TursoDb(metaNative);
      await meta.run(`
        CREATE TABLE shards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          scope_hash TEXT NOT NULL,
          shard_index INTEGER NOT NULL,
          db_path TEXT NOT NULL,
          vector_count INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          UNIQUE(scope, scope_hash, shard_index)
        )
      `);
      await meta.run(
        `INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["project", "a1b2c3d4e5f67890", 0, `projects/${fileName}`, 1, 1, Date.now()]
      );
      await meta.close();
    }

    return dbPath;
  }

  migrationTest("is a no-op when encryption is disabled", async () => {
    await withStorage(false);
    await createPlaintextShard("project_a1b2c3d4e5f67890_shard_0.db");

    const { runDatabaseEncryptionMigration } =
      await import("../src/storage/turso/encryption-migrator.js");
    await runDatabaseEncryptionMigration();
    expect(existsSync(join(baseDir, ".tursodb-encrypted-v1"))).toBe(false);

    const plain = await connect(join(baseDir, "projects", "project_a1b2c3d4e5f67890_shard_0.db"), {
      experimental: ["encryption"],
    });
    await plain.close();
  });

  migrationTest("encrypts plaintext shards and skips Turso-internal tables", async () => {
    await withStorage(true);
    const dbPath = await createPlaintextShard("project_a1b2c3d4e5f67890_shard_0.db", true);

    const { resolveOrCreateDatabaseEncryptionKey } =
      await import("../src/storage/turso/encryption-key.js");
    const hexkey = resolveOrCreateDatabaseEncryptionKey();
    expect(hexkey).toBeTruthy();

    const { runDatabaseEncryptionMigration } =
      await import("../src/storage/turso/encryption-migrator.js");
    await runDatabaseEncryptionMigration();

    const marker = join(baseDir, ".tursodb-encrypted-v1");
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, "utf-8")).cipher).toBe("aes256gcm");
    expect(
      readdirSync(join(baseDir, "projects")).some((name) => name.includes(".pre-encrypt-"))
    ).toBe(true);

    await expect(connect(dbPath, { experimental: ["encryption"] })).rejects.toThrow();

    const encrypted = await connect(dbPath, {
      encryption: { cipher: "aes256gcm", hexkey: hexkey! },
      experimental: ["encryption"],
    });
    try {
      const row = await encrypted
        .prepare("SELECT id, content FROM memories WHERE id = ?")
        .get("mem_plain");
      expect(row?.content).toBe("encrypt me");
    } finally {
      await encrypted.close();
    }

    const metaPath = join(baseDir, "metadata.db");
    const meta = await connect(metaPath, {
      encryption: { cipher: "aes256gcm", hexkey: hexkey! },
      experimental: ["encryption"],
    });
    try {
      const shard = await meta.prepare("SELECT scope_hash FROM shards").get();
      expect(shard?.scope_hash).toBe("a1b2c3d4e5f67890");
    } finally {
      await meta.close();
    }
  });

  migrationTest("is idempotent when the encryption marker already exists", async () => {
    await withStorage(true);
    const dbPath = await createPlaintextShard("project_a1b2c3d4e5f67890_shard_0.db");
    const { resolveOrCreateDatabaseEncryptionKey } =
      await import("../src/storage/turso/encryption-key.js");
    const hexkey = resolveOrCreateDatabaseEncryptionKey()!;

    const { runDatabaseEncryptionMigration } =
      await import("../src/storage/turso/encryption-migrator.js");
    await runDatabaseEncryptionMigration();
    const before = readdirSync(baseDir).filter((n) => n.includes(".pre-encrypt-")).length;

    await runDatabaseEncryptionMigration();
    const after = readdirSync(baseDir).filter((n) => n.includes(".pre-encrypt-")).length;
    expect(after).toBe(before);

    const encrypted = await connect(dbPath, {
      encryption: { cipher: "aes256gcm", hexkey },
      experimental: ["encryption"],
    });
    await encrypted.close();
  });

  migrationTest("keeps shard manager usable after encrypting metadata.db", async () => {
    // Create and warm while encryption is still off, then flip it on for migration.
    await withStorage(false);
    await createPlaintextShard("project_a1b2c3d4e5f67890_shard_0.db", true);

    const { tursoShardManager } = await import("../src/storage/turso/shard-manager.js");
    await tursoShardManager.getAllShards("project", "");

    const { CONFIG } = await import("../src/config.js");
    CONFIG.databaseEncryptionEnabled = true;
    CONFIG.databaseEncryptionKey = `file://${join(baseDir, "config", "opencode-mem-db.key")}`;

    const { resolveOrCreateDatabaseEncryptionKey } =
      await import("../src/storage/turso/encryption-key.js");
    resolveOrCreateDatabaseEncryptionKey();

    const { runDatabaseEncryptionMigration } =
      await import("../src/storage/turso/encryption-migrator.js");
    await runDatabaseEncryptionMigration();

    // Must not throw with a stale closed metadata handle.
    await tursoShardManager.createShard("project", "b2c3d4e5f6789012", 0);
    const created = await tursoShardManager.getAllShards("project", "b2c3d4e5f6789012");
    expect(created).toHaveLength(1);
  });
});
