import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@tursodatabase/database";
import { CONFIG } from "../src/config.js";
import { TursoConnectionManager } from "../src/services/turso/connection-manager.js";
import { TursoDb } from "../src/services/turso/turso-db.js";

function fakeDatabase(all: (sql: string) => Promise<unknown[]>) {
  const calls: string[] = [];
  const database = {
    calls,
    async all(sql: string) {
      calls.push(sql);
      return all(sql);
    },
    async run(sql: string) {
      calls.push(sql);
      return { changes: 0, lastInsertRowid: 0 };
    },
    async get() {
      return undefined;
    },
    async batch() {
      return [];
    },
    async close() {
      calls.push("close");
    },
  };
  return database as unknown as Database & { calls: string[] };
}

describe("turso close checkpoint", () => {
  it("checkpoints the WAL before closing", async () => {
    const database = fakeDatabase(async () => []);
    await new TursoDb(database).close();

    expect(database.calls).toEqual(["PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
  });

  it("still closes when the checkpoint fails", async () => {
    const database = fakeDatabase(async () => {
      throw new Error("database is locked");
    });
    await new TursoDb(database).close();

    expect(database.calls).toEqual(["PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
  });

  it("does not leak the checkpoint rejection that lands after the timeout", async () => {
    // Bun's test runner fails any test that leaks an unhandled rejection, so a
    // regression here surfaces as a suite failure rather than a silent hang.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const calls: string[] = [];
      const database = {
        async all() {
          calls.push("all");
          await new Promise((resolve) => setTimeout(resolve, 80));
          throw new Error("database is locked");
        },
        async close() {
          calls.push("close");
        },
      } as unknown as Database;

      const db = new TursoDb(database, 10);
      await db.close();

      expect(calls).toEqual(["all", "close"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("waits for a timed-out checkpoint to settle before closing", async () => {
    // turso's close() does not take execLock — closing under an in-flight
    // pragma would race the native handle. After the timeout fires we must
    // still drain the checkpoint before close runs.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const database = {
      async all() {
        calls.push("all");
        await gate;
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      },
      async close() {
        calls.push("close");
      },
    } as unknown as Database;

    const closing = new TursoDb(database, 10).close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual(["all"]);

    release();
    await closing;
    expect(calls).toEqual(["all", "close"]);
  });

  it("still closes when logging fails", async () => {
    // Point the log file inside a regular file so the logger's mkdir/write
    // throws (ENOTDIR) on both the success and failure log calls.
    const sandbox = mkdtempSync(join(tmpdir(), "turso-log-fail-"));
    const previousLogFile = process.env.OPENCODE_MEM_LOG_FILE;
    writeFileSync(join(sandbox, "blocker"), "x");
    process.env.OPENCODE_MEM_LOG_FILE = join(sandbox, "blocker", "opencode-mem.log");
    try {
      const database = fakeDatabase(async () => [{ busy: 0, log: 0, checkpointed: 0 }]);
      await new TursoDb(database).close();

      expect(database.calls).toEqual(["PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
    } finally {
      if (previousLogFile === undefined) {
        delete process.env.OPENCODE_MEM_LOG_FILE;
      } else {
        process.env.OPENCODE_MEM_LOG_FILE = previousLogFile;
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("closeSync closes without running the checkpoint", () => {
    const database = fakeDatabase(async () => []);
    new TursoDb(database).closeSync();

    // No await: the native close still happened on this tick.
    expect(database.calls).toEqual(["close"]);
  });

  it("closeAllSync releases the native handle on the exit path", async () => {
    const previousStoragePath = CONFIG.storagePath;
    const sandbox = mkdtempSync(join(tmpdir(), "turso-sync-close-"));
    CONFIG.storagePath = sandbox;
    try {
      const manager = new TursoConnectionManager();
      const db = await manager.getConnection(join(sandbox, "sync.db"));
      await db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
      const client = db.getClient();
      expect(client.open).toBeTrue();

      manager.closeAllSync();

      // Same tick, before any await: the async turso close() runs the native
      // close before its first (and only) statement can yield.
      expect(client.open).toBeFalse();
    } finally {
      CONFIG.storagePath = previousStoragePath;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
