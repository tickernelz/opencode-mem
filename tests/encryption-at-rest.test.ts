import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";
import { connect } from "@tursodatabase/database";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";
import { TursoDb } from "../src/storage/turso/turso-db.js";
import {
  ensureDatabaseEncryptionKeyFile,
  generateDatabaseEncryptionKeyFile,
  isValidDatabaseEncryptionHexKey,
  resolveOrCreateDatabaseEncryptionKey,
} from "../src/storage/turso/encryption-key.js";

describe("encryption at rest", () => {
  let baseDir: string;
  let restoreConfig: (() => void) | undefined;

  afterEach(async () => {
    restoreConfig?.();
    restoreConfig = undefined;
    await cleanupTursoTestDirectory(baseDir);
  });

  async function withIsolatedEncryptionConfig(
    mutate: (config: typeof import("../src/config.js").CONFIG) => void
  ) {
    const { CONFIG } = await import("../src/config.js");
    const previous = {
      storagePath: CONFIG.storagePath,
      databaseEncryptionEnabled: CONFIG.databaseEncryptionEnabled,
      databaseEncryptionKey: CONFIG.databaseEncryptionKey,
      databaseEncryptionCipher: CONFIG.databaseEncryptionCipher,
    };
    restoreConfig = () => {
      CONFIG.storagePath = previous.storagePath;
      CONFIG.databaseEncryptionEnabled = previous.databaseEncryptionEnabled;
      CONFIG.databaseEncryptionKey = previous.databaseEncryptionKey;
      CONFIG.databaseEncryptionCipher = previous.databaseEncryptionCipher;
    };
    mutate(CONFIG);
  }

  it("opens encrypted DBs with the correct key and rejects missing keys", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-enc-"));
    const dbPath = join(baseDir, "enc.db");
    const hexkey = "b1bbfda4f589dc9daaf004fe21111e00dc00c98237102f5c7002a5669fc76327";

    const created = await connect(dbPath, {
      encryption: { cipher: "aes256gcm", hexkey },
      experimental: ["encryption"],
    });
    const db = new TursoDb(created);
    await db.run("CREATE TABLE t (x INTEGER)");
    await db.run("INSERT INTO t VALUES (42)");
    await db.close();

    await expect(connect(dbPath, { experimental: ["encryption"] })).rejects.toThrow();

    const reopened = await connect(dbPath, {
      encryption: { cipher: "aes256gcm", hexkey },
      experimental: ["encryption"],
    });
    const rows = await reopened.prepare("SELECT x FROM t").all();
    expect(rows[0]?.x).toBe(42);
    await reopened.close();
  });

  it("auto-generates a 64-char hex key file with owner-only permissions", () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-enc-key-"));
    const keyPath = join(baseDir, "keys", "opencode-mem-db.key");

    const hex = generateDatabaseEncryptionKeyFile(keyPath);
    expect(isValidDatabaseEncryptionHexKey(hex)).toBe(true);
    expect(hex).toHaveLength(64);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, "utf-8").trim()).toBe(hex);

    if (platform() !== "win32") {
      const mode = statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Second ensure reuses the same key
    expect(ensureDatabaseEncryptionKeyFile(keyPath)).toBe(hex);
  });

  it("refuses to generate a new key when encrypted DBs already exist", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-enc-refuse-"));
    await withIsolatedEncryptionConfig((CONFIG) => {
      CONFIG.storagePath = baseDir;
    });
    writeFileSync(join(baseDir, ".tursodb-encrypted-v1"), "{}");

    const keyPath = join(baseDir, "missing.key");
    expect(() => generateDatabaseEncryptionKeyFile(keyPath)).toThrow(/already exist/);
  });

  it("resolveOrCreateDatabaseEncryptionKey is null when encryption is off", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-enc-off-"));
    await withIsolatedEncryptionConfig((CONFIG) => {
      CONFIG.storagePath = baseDir;
      CONFIG.databaseEncryptionEnabled = false;
      CONFIG.databaseEncryptionKey = undefined;
    });
    expect(resolveOrCreateDatabaseEncryptionKey()).toBeNull();
  });

  it("resolveOrCreateDatabaseEncryptionKey auto-creates default-style file when enabled", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-enc-on-"));
    mkdirSync(join(baseDir, "config"), { recursive: true });
    const keyPath = join(baseDir, "config", "opencode-mem-db.key");

    await withIsolatedEncryptionConfig((CONFIG) => {
      CONFIG.storagePath = baseDir;
      CONFIG.databaseEncryptionEnabled = true;
      CONFIG.databaseEncryptionKey = `file://${keyPath}`;
    });

    const hex = resolveOrCreateDatabaseEncryptionKey();
    expect(hex).toBeTruthy();
    expect(isValidDatabaseEncryptionHexKey(hex!)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
  });
});
