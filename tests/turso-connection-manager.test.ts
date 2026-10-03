import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso connection manager", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("deduplicates concurrent getConnection calls for the same path", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-race-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "single.db");

    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");

    const [a, b, c] = await Promise.all([
      tursoConnectionManager.getConnection(dbPath),
      tursoConnectionManager.getConnection(dbPath),
      tursoConnectionManager.getConnection(dbPath),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("waits for an in-flight open before closing and serializes a reopen", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-close-race-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "close-race.db");

    let releaseOpen!: () => void;
    let markOpenStarted!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const clientStates: Array<{ closed: boolean }> = [];
    let openCount = 0;
    const connectFactory = async () => {
      const clientIndex = openCount++;
      const state = { closed: false };
      clientStates.push(state);
      if (clientIndex === 0) {
        markOpenStarted();
        await openGate;
      }
      return {
        async exec() {},
        async run(sql: string) {
          if (clientIndex === 0 && sql === "PRAGMA foreign_keys = ON") {
            markOpenStarted();
            await openGate;
          }
          return { changes: 0, lastInsertRowid: 0 };
        },
        async get(sql: string) {
          if (sql === "PRAGMA foreign_keys") return { foreign_keys: 1 };
          return undefined;
        },
        async all(sql: string) {
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
        async close() {
          state.closed = true;
        },
      } as any;
    };
    const { TursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);

    try {
      const opening = manager.getConnection(dbPath);
      await openStarted;

      let closeSettled = false;
      const closing = manager.closeConnection(dbPath).then(() => {
        closeSettled = true;
      });
      const reopening = manager.getConnection(dbPath);

      await Promise.resolve();
      expect(closeSettled).toBeFalse();

      releaseOpen();
      const opened = await opening;
      await closing;
      const reopened = await reopening;

      expect(reopened).not.toBe(opened);
      expect(clientStates).toHaveLength(2);
      expect(clientStates[0]?.closed).toBeTrue();
      const row = await reopened.get(`PRAGMA foreign_keys`);
      expect(Number((row as { foreign_keys?: number } | null)?.foreign_keys)).toBe(1);
    } finally {
      releaseOpen();
      await manager.closeAll();
    }
  });

  it("enables foreign keys on new connections", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-fk-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "fk.db");

    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(dbPath);
    const row = await db.get(`PRAGMA foreign_keys`);
    expect(Number((row as { foreign_keys?: number } | null)?.foreign_keys)).toBe(1);
  });

  it("opens databases with experimental encryption opts enabled", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-opts-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    CONFIG.databaseEncryptionEnabled = false;
    const dbPath = join(baseDir, "opts.db");

    const opens: Array<{ path: string; opts?: Record<string, unknown> }> = [];
    const connectFactory = async (path: string, opts?: Record<string, unknown>) => {
      opens.push({ path, opts });
      return {
        async exec() {},
        async run() {
          return { changes: 0, lastInsertRowid: 0 };
        },
        async get() {
          return undefined;
        },
        async all() {
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
    };

    const { TursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    const manager = new TursoConnectionManager(connectFactory);
    try {
      await manager.getConnection(dbPath);
      expect(opens).toHaveLength(1);
      expect(opens[0]?.path).toBe(dbPath);
      expect(opens[0]?.opts).toMatchObject({
        experimental:
          process.platform === "win32" ? ["encryption"] : ["encryption", "multiprocess_wal"],
      });
      expect(opens[0]?.opts).not.toHaveProperty("encryption");
    } finally {
      await manager.closeAll();
    }
  });

  it("refuses paths outside storagePath", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-outside-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { tursoConnectionManager } = await import("../src/storage/turso/connection-manager.js");
    await expect(tursoConnectionManager.getConnection("/tmp/outside.db")).rejects.toThrow(
      /outside storagePath/
    );
  });
});
