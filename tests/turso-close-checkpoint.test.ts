import { describe, expect, it } from "bun:test";
import type { Database } from "@tursodatabase/database";
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

      // Give the abandoned checkpoint time to reject and surface.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
