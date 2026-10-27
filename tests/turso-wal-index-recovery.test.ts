import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConnectFactory } from "../src/services/turso/connection-manager.js";
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

function recoveryEntries(baseDir: string): string[] {
  const root = join(baseDir, "recovery");
  return existsSync(root) ? readdirSync(root).sort() : [];
}

function quarantineDirs(baseDir: string): string[] {
  return recoveryEntries(baseDir).filter((entry) => !entry.endsWith(".lock"));
}

describe("turso WAL index recovery", () => {
  let baseDir: string;

  afterEach(async () => {
    setSystemTime();
    delete process.env.OPENCODE_MEM_LOG_FILE;
    const { CONFIG } = await import("../src/config.js");
    CONFIG.tursoAutoHeal = true;
    CONFIG.tursoMultiprocessWal = true;
    await cleanupTursoTestDirectory(baseDir);
  });

  async function prepare(prefix: string, options: { wal?: string } = {}) {
    baseDir = mkdtempSync(join(tmpdir(), prefix));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.databaseEncryptionEnabled = false;
    const dbPath = join(baseDir, "memories.db");
    writeFileSync(dbPath, "main");
    writeFileSync(`${dbPath}-wal`, options.wal ?? "");
    writeFileSync(`${dbPath}-shm`, "shm");
    writeFileSync(`${dbPath}-tshm`, "tshm");
    return dbPath;
  }

  it("quarantines only the index sidecars (0-byte WAL) and retries the open exactly once", async () => {
    const dbPath = await prepare("turso-heal-ok-");
    const calls: string[] = [];
    let liveOpens = 0;
    const connectFactory = async (path: string) => {
      calls.push(path);
      if (path === dbPath) {
        liveOpens += 1;
        // Fail the open and the lock recheck, then succeed after the quarantine.
        if (liveOpens <= 2) throw new Error(SHORT_READ);
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

    // failed open → lock recheck → copy verification → single retry
    expect(calls.filter((path) => path === dbPath)).toHaveLength(3);
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain("memories.db");
    expect(calls[2]).not.toBe(dbPath);
    const [quarantined] = quarantineDirs(baseDir);
    expect(quarantined).toBeDefined();
    expect(readdirSync(join(baseDir, "recovery", quarantined as string)).sort()).toEqual([
      "memories.db-shm",
      "memories.db-tshm",
    ]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-tshm`)).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    expect(recoveryEntries(baseDir).filter((entry) => entry.endsWith(".lock"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a non-empty -wal and preserves committed rows across the reopen",
    async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-heal-wal-"));
      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.databaseEncryptionEnabled = false;

      const { connect } = await import("@tursodatabase/database");
      const { buildConnectOptions, TursoConnectionManager } =
        await import("../src/services/turso/connection-manager.js");

      const dbPath = join(baseDir, "memories.db");
      const opts = buildConnectOptions();
      const seed = await connect(dbPath, opts);
      await seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      await seed.run("INSERT INTO t (v) VALUES (?)", ["checkpointed"]);
      await seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await seed.run("INSERT INTO t (v) VALUES (?)", ["wal-only"]);
      await seed.close();

      const walPath = `${dbPath}-wal`;
      const walInode = statSync(walPath).ino;
      expect(statSync(walPath).size).toBeGreaterThan(0);
      expect(existsSync(`${dbPath}-tshm`)).toBe(true);

      let liveOpens = 0;
      const connectFactory: ConnectFactory = async (path, openOpts) => {
        if (path === dbPath) {
          liveOpens += 1;
          // Fail the first attempt and the lock recheck; heal, then really reopen.
          if (liveOpens <= 2) throw new Error(SHORT_READ);
        }
        return connect(path, openOpts);
      };

      const manager = new TursoConnectionManager(connectFactory);
      let values: string[];
      try {
        const db = await manager.getConnection(dbPath);
        values = (await db.all<{ v: string }>("SELECT v FROM t ORDER BY id")).map((row) => row.v);
      } finally {
        await manager.closeAll();
      }

      // The WAL was not discarded, and its committed row survived the recovery.
      expect(values).toEqual(["checkpointed", "wal-only"]);
      expect(existsSync(walPath)).toBe(true);
      expect(statSync(walPath).size).toBeGreaterThan(0);
      // Same inode: the file was kept, not moved and recreated.
      expect(statSync(walPath).ino).toBe(walInode);

      const [quarantined] = quarantineDirs(baseDir);
      const quarantinedFiles = readdirSync(join(baseDir, "recovery", quarantined as string)).sort();
      expect(quarantinedFiles).toContain("memories.db-tshm");
      expect(quarantinedFiles.every((name) => /-(shm|tshm)$/.test(name))).toBe(true);
      // Engine evidence, not an assumption: the old -tshm is in quarantine *and*
      // a fresh, non-empty index exists beside the WAL again, rebuilt on reopen.
      // The seeded WAL has no torn trailing frame; a torn WAL is the
      // "retry fails, original error surfaces, WAL untouched" case.
      expect(existsSync(`${dbPath}-tshm`)).toBe(true);
      expect(statSync(`${dbPath}-tshm`).size).toBeGreaterThan(0);
    }
  );

  it("heals the invalid-page-type failure too", async () => {
    const dbPath = await prepare("turso-heal-page-");
    let liveOpens = 0;
    const connectFactory = async (path: string) => {
      if (path === dbPath) {
        liveOpens += 1;
        if (liveOpens <= 2) throw new Error(INVALID_PAGE);
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

    expect(quarantineDirs(baseDir)).toHaveLength(1);
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

    // failed open + lock recheck, then the verification copy — no retry.
    expect(calls.filter((path) => path === dbPath)).toHaveLength(2);
    expect(recoveryEntries(baseDir)).toEqual([]);
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

    // failed open, lock recheck and the single retry — no second heal cycle.
    expect(calls.filter((path) => path === dbPath)).toHaveLength(3);
    expect(quarantineDirs(baseDir)).toHaveLength(1);
    expect(recoveryEntries(baseDir).filter((entry) => entry.endsWith(".lock"))).toEqual([]);
  });

  it("does not recover while another process holds the recovery lock", async () => {
    const dbPath = await prepare("turso-heal-lock-");
    const { acquireRecoveryLock, recoveryLockPathFor } =
      await import("../src/services/turso/wal-index-recovery.js");
    const held = acquireRecoveryLock(dbPath);
    expect(held).not.toBeNull();
    const lockPath = recoveryLockPathFor(dbPath);

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

    try {
      // Only the initial open: no recheck, no copy, no moves.
      expect(calls).toEqual([dbPath]);
      expect(existsSync(lockPath)).toBe(true);
      expect(quarantineDirs(baseDir)).toEqual([]);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(existsSync(`${dbPath}-tshm`)).toBe(true);
    } finally {
      held?.release();
    }
  });

  it("returns the peer-healed connection when the open succeeds under the lock", async () => {
    const dbPath = await prepare("turso-heal-recheck-");
    const peerConnection = stubDatabase([{ integrity_check: "ok" }]);
    const calls: string[] = [];
    const connectFactory = async (path: string) => {
      calls.push(path);
      if (path !== dbPath) {
        return stubDatabase([{ integrity_check: "ok" }]);
      }
      if (calls.filter((call) => call === dbPath).length === 1) {
        throw new Error(SHORT_READ);
      }
      return peerConnection;
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      const db = await manager.getConnection(dbPath);
      expect(db.getClient()).toBe(peerConnection);
    } finally {
      await manager.closeAll();
    }

    // failed open → recheck only; the verification copy is never opened.
    expect(calls).toEqual([dbPath, dbPath]);
    expect(recoveryEntries(baseDir)).toEqual([]);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(existsSync(`${dbPath}-tshm`)).toBe(true);
  });

  it("rethrows the original error when a quarantine rename fails mid-way", async () => {
    const dbPath = await prepare("turso-heal-fs-");
    const logFile = join(baseDir, "recovery.log");
    process.env.OPENCODE_MEM_LOG_FILE = logFile;

    // Freeze the clock so the timestamped quarantine dir is predictable.
    setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    const quarantineDir = join(baseDir, "recovery", "memories-2026-01-02T03-04-05-678Z");
    // Block the second sidecar (-shm). -tshm is moved first so a partial
    // quarantine still removes the Turso index that blocks open.
    const blocker = join(quarantineDir, "memories.db-shm");
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, "blocker"), "x");

    let liveOpens = 0;
    const connectFactory = async (path: string) => {
      if (path === dbPath) {
        liveOpens += 1;
        // Fail open, lock recheck, and the post-partial retry.
        if (liveOpens <= 3) throw new Error(SHORT_READ);
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

    // -tshm moved before the -shm rename failed; the WAL was untouched.
    // The blocker directory remains under the quarantine name.
    expect(readdirSync(quarantineDir).sort()).toEqual(["memories.db-shm", "memories.db-tshm"]);
    expect(existsSync(`${dbPath}-tshm`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(recoveryEntries(baseDir).filter((entry) => entry.endsWith(".lock"))).toEqual([]);
    // open + recheck + partial-failure retry
    expect(liveOpens).toBe(3);

    const logged = readFileSync(logFile, "utf8");
    expect(logged).toContain("WAL index recovery failed");
    expect(logged).toContain(dbPath);
    expect(logged).toContain(quarantineDir);
    expect(logged).toContain("short read on WAL frame");
  });

  it("can finish recovery in-process after a quarantine that moved nothing", async () => {
    const dbPath = await prepare("turso-heal-fs-retry-");
    setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    const quarantineDir = join(baseDir, "recovery", "memories-2026-01-02T03-04-05-678Z");
    // Block the first sidecar so the first attempt moves nothing.
    const blocker = join(quarantineDir, "memories.db-tshm");
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, "blocker"), "x");

    let liveOpens = 0;
    const connectFactory = async (path: string) => {
      if (path === dbPath) {
        liveOpens += 1;
        // First attempt: open + recheck fail (no post-quarantine retry — nothing moved).
        // Second attempt: open + recheck fail, then succeed after a real quarantine.
        if (liveOpens <= 4) throw new Error(SHORT_READ);
      }
      return stubDatabase([{ integrity_check: "ok" }]);
    };

    const { TursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await expect(manager.getConnection(dbPath)).rejects.toThrow(/short read on WAL frame/);
      expect(existsSync(`${dbPath}-tshm`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);

      // Clear the blocker so the next open can quarantine both sidecars.
      rmSync(blocker, { recursive: true, force: true });

      await manager.getConnection(dbPath);
    } finally {
      await manager.closeAll();
    }

    expect(existsSync(`${dbPath}-tshm`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(quarantineDirs(baseDir).length).toBeGreaterThanOrEqual(1);
    expect(liveOpens).toBe(5);
  });

  it("takes over a stale recovery lock and proceeds", async () => {
    const dbPath = await prepare("turso-heal-stale-");
    const { recoveryLockPathFor } = await import("../src/services/turso/wal-index-recovery.js");
    const lockPath = recoveryLockPathFor(dbPath);
    mkdirSync(join(baseDir, "recovery"), { recursive: true });
    writeFileSync(lockPath, "999999 crashed healer\n");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, tenMinutesAgo, tenMinutesAgo);

    let liveOpens = 0;
    const connectFactory = async (path: string) => {
      if (path === dbPath) {
        liveOpens += 1;
        if (liveOpens <= 2) throw new Error(SHORT_READ);
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

    // initial open, lock recheck, single retry after the sidecars were moved.
    expect(liveOpens).toBe(3);
    expect(quarantineDirs(baseDir)).toHaveLength(1);
    expect(existsSync(`${dbPath}-tshm`)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
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
    expect(recoveryEntries(baseDir)).toEqual([]);
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
    expect(recoveryEntries(baseDir)).toEqual([]);
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
