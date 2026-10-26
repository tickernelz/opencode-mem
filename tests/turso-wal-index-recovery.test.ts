import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

const SHORT_READ = "I/O error: short read on WAL frame at offset 4096: expected 4096 bytes, got 0";
const INVALID_PAGE = "Corrupt database: Invalid page type: 0";

function stubDatabase(integrityRows: Array<Record<string, unknown>>) {
  return {
    async exec() {},
    async run() {
      return { changes: 0, lastInsertRowid: 0 };
    },
    async get(sql: string) {
      if (sql === "PRAGMA integrity_check") return integrityRows[0];
      if (sql === "PRAGMA foreign_keys") return { foreign_keys: 1 };
      return undefined;
    },
    async all(sql: string) {
      if (sql === "PRAGMA integrity_check") return integrityRows;
      if (sql === "PRAGMA foreign_keys") return [{ foreign_keys: 1 }];
      return [];
    },
    async batch() {
      return [];
    },
    transactionAsync() {
      return {
        immediate: async () => undefined,
        deferred: async () => undefined,
      };
    },
    async close() {},
  } as any;
}

describe("turso WAL index recovery", () => {
  let baseDir: string;

  afterEach(async () => {
    const { CONFIG } = await import("../src/config.js");
    CONFIG.tursoAutoHeal = true;
    CONFIG.tursoMultiprocessWal = true;
    await cleanupTursoTestDirectory(baseDir);
  });

  async function prepare(prefix: string) {
    baseDir = mkdtempSync(join(tmpdir(), prefix));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.databaseEncryptionEnabled = false;
    const dbPath = join(baseDir, "memories.db");
    writeFileSync(dbPath, "main");
    writeFileSync(`${dbPath}-wal`, "");
    writeFileSync(`${dbPath}-shm`, "shm");
    writeFileSync(`${dbPath}-tshm`, "tshm");
    return dbPath;
  }

  it("quarantines the sidecars and retries the open exactly once", async () => {
    const dbPath = await prepare("turso-heal-ok-");
    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      if (path === dbPath && calls.length === 1) {
        throw new Error(SHORT_READ);
      }
      return stubDatabase([{ integrity_check: "ok" }]);
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await manager.getConnection(dbPath);
    } finally {
      await manager.closeAll();
    }

    expect(calls.filter((path) => path === dbPath)).toHaveLength(2);
    expect(calls[0]).toBe(dbPath);
    // The verification copy lives in a temp dir, never at the live path.
    expect(calls[1]).not.toBe(dbPath);
    expect(calls[1]).toContain("memories.db");

    const recoveryRoot = join(baseDir, "recovery");
    const quarantined = readdirSync(recoveryRoot);
    expect(quarantined).toHaveLength(1);
    const quarantineDir = join(recoveryRoot, quarantined[0] as string);
    expect(readdirSync(quarantineDir).sort()).toEqual([
      "memories.db-shm",
      "memories.db-tshm",
      "memories.db-wal",
    ]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-tshm`)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("heals the invalid-page-type failure too", async () => {
    const dbPath = await prepare("turso-heal-page-");
    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      if (path === dbPath && calls.length === 1) {
        throw new Error(INVALID_PAGE);
      }
      return stubDatabase([{ integrity_check: "ok" }]);
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await manager.getConnection(dbPath);
    } finally {
      await manager.closeAll();
    }

    expect(readdirSync(join(baseDir, "recovery"))).toHaveLength(1);
    expect(existsSync(`${dbPath}-tshm`)).toBe(false);
  });

  it("moves nothing when the copy fails integrity_check", async () => {
    const dbPath = await prepare("turso-heal-bad-");
    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      if (path === dbPath) {
        throw new Error(SHORT_READ);
      }
      return stubDatabase([{ integrity_check: "*** in database main *** page 2 is never used" }]);
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await expect(manager.getConnection(dbPath)).rejects.toThrow(/short read on WAL frame/);
    } finally {
      await manager.closeAll();
    }

    expect(calls.filter((path) => path === dbPath)).toHaveLength(1);
    expect(existsSync(join(baseDir, "recovery"))).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(existsSync(`${dbPath}-tshm`)).toBe(true);
  });

  it("surfaces the original error and does not loop when the retry fails", async () => {
    const dbPath = await prepare("turso-heal-retry-");
    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      if (path === dbPath) {
        throw new Error(SHORT_READ);
      }
      return stubDatabase([{ integrity_check: "ok" }]);
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await expect(manager.getConnection(dbPath)).rejects.toThrow(/short read on WAL frame/);
    } finally {
      await manager.closeAll();
    }

    // One copy verification plus the single retry — no second heal cycle.
    expect(calls.filter((path) => path === dbPath)).toHaveLength(2);
    expect(readdirSync(join(baseDir, "recovery"))).toHaveLength(1);
  });

  it("ignores open errors outside the two known signatures", async () => {
    const dbPath = await prepare("turso-heal-other-");
    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      throw new Error("disk quota exceeded");
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await expect(manager.getConnection(dbPath)).rejects.toThrow(/disk quota exceeded/);
    } finally {
      await manager.closeAll();
    }

    expect(calls).toHaveLength(1);
    expect(existsSync(join(baseDir, "recovery"))).toBe(false);
    expect(existsSync(`${dbPath}-tshm`)).toBe(true);
  });

  it("does not heal when tursoAutoHeal is false", async () => {
    const dbPath = await prepare("turso-heal-off-");
    const { CONFIG } = await import("../src/config.js");
    CONFIG.tursoAutoHeal = false;

    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      throw new Error(SHORT_READ);
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await expect(manager.getConnection(dbPath)).rejects.toThrow(/short read on WAL frame/);
    } finally {
      await manager.closeAll();
    }

    expect(calls).toHaveLength(1);
    expect(existsSync(join(baseDir, "recovery"))).toBe(false);
    expect(existsSync(`${dbPath}-tshm`)).toBe(true);
  });

  it("drops multiprocess_wal when tursoMultiprocessWal is false", async () => {
    const { CONFIG } = await import("../src/config.js");
    const { buildConnectOptions, tursoExperimentalFeatures } =
      await import("../src/services/turso/connection-manager.js");
    try {
      CONFIG.tursoMultiprocessWal = false;
      expect(tursoExperimentalFeatures("linux")).toEqual(["encryption"]);
      expect(buildConnectOptions()).toEqual({ experimental: ["encryption"] });
    } finally {
      CONFIG.tursoMultiprocessWal = true;
    }

    expect(tursoExperimentalFeatures("linux")).toEqual(["encryption", "multiprocess_wal"]);
    expect(tursoExperimentalFeatures("linux", false)).toEqual(["encryption"]);
    expect(tursoExperimentalFeatures("linux", true)).toEqual(["encryption", "multiprocess_wal"]);
  });
});
