import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso operation lock staleness", () => {
  let baseDir: string;
  let restoreConfig: (() => void) | undefined;
  let staleMs: number;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
    restoreConfig?.();
  });

  async function withStorage() {
    baseDir = mkdtempSync(join(tmpdir(), "turso-lock-staleness-"));
    const { CONFIG } = await import("../src/config.js");
    const previous = { storagePath: CONFIG.storagePath };
    restoreConfig = () => Object.assign(CONFIG, previous);
    CONFIG.storagePath = baseDir;
    const locks = await import("../src/services/turso/operation-lock.js");
    staleMs = locks.TURSO_LOCK_STALE_MS;
    return locks;
  }

  const oldTimestamp = () => new Date(Date.now() - staleMs - 60_000).toISOString();

  it("does not unlink a replacement file using the inspected stale identity", async () => {
    const { unlinkTursoLockIfUnchanged } = await withStorage();
    const path = join(baseDir, ".turso-operation.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, timestamp: oldTimestamp() }));
    const identity = statSync(path);
    renameSync(path, `${path}.old`);
    writeFileSync(path, "replacement");
    expect(unlinkTursoLockIfUnchanged(path, identity)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("replacement");
  });

  it("re-evaluates and blocks a fresh replacement between stale read and cleanup", async () => {
    const { assertNoTursoMigrationInProgress } = await withStorage();
    const path = join(baseDir, ".turso-operation.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, timestamp: oldTimestamp() }));
    const original = fs.readFileSync;
    let replaced = false;
    const read = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof original>
    ) => {
      const contents = original(...args);
      if (typeof args[0] === "number" && !replaced) {
        replaced = true;
        renameSync(path, `${path}.old`);
        writeFileSync(
          path,
          JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), id: "foreign" })
        );
      }
      return contents;
    }) as typeof original);
    try {
      expect(() => assertNoTursoMigrationInProgress()).toThrow(/writes are temporarily blocked/);
      expect(replaced).toBe(true);
      expect(JSON.parse(original(path, "utf-8")).id).toBe("foreign");
    } finally {
      read.mockRestore();
    }
  });

  for (const file of [".turso-operation.lock", ".turso-migrate.lock"]) {
    it(`cleans an aged-out live PID in ${file}`, async () => {
      const { assertNoTursoMigrationInProgress } = await withStorage();
      const path = join(baseDir, file);
      writeFileSync(path, JSON.stringify({ pid: process.pid, timestamp: oldTimestamp() }));
      expect(() => assertNoTursoMigrationInProgress()).not.toThrow();
      expect(existsSync(path)).toBe(false);
    });

    it(`blocks a fresh live PID in ${file}`, async () => {
      const { assertNoTursoMigrationInProgress } = await withStorage();
      const path = join(baseDir, file);
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() })
      );
      expect(() => assertNoTursoMigrationInProgress()).toThrow(/writes are temporarily blocked/);
      expect(existsSync(path)).toBe(true);
    });

    it(`cleans a dead PID and corrupt JSON in ${file}`, async () => {
      const { assertNoTursoMigrationInProgress } = await withStorage();
      const path = join(baseDir, file);
      // Outside supported OS PID ranges, so this cannot accidentally name a live process.
      writeFileSync(path, JSON.stringify({ pid: 2147483647, timestamp: new Date().toISOString() }));
      expect(() => assertNoTursoMigrationInProgress()).not.toThrow();
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, "{broken");
      expect(() => assertNoTursoMigrationInProgress()).not.toThrow();
      expect(existsSync(path)).toBe(false);
    });

    for (const timestamp of [undefined, "invalid"]) {
      it(`uses mtime for ${file} with timestamp ${String(timestamp)}`, async () => {
        const { assertNoTursoMigrationInProgress } = await withStorage();
        const path = join(baseDir, file);
        writeFileSync(path, JSON.stringify({ pid: process.pid, timestamp }));
        expect(() => assertNoTursoMigrationInProgress()).toThrow(/writes are temporarily blocked/);
        const old = new Date(oldTimestamp());
        utimesSync(path, old, old);
        expect(() => assertNoTursoMigrationInProgress()).not.toThrow();
        expect(existsSync(path)).toBe(false);
      });
    }
  }

  it("allows legacy migration to acquire an aged-out live lock", async () => {
    await withStorage();
    const path = join(baseDir, ".turso-migrate.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, timestamp: oldTimestamp() }));
    const { runLegacyTursoMigration } = await import("../src/services/turso/legacy-migrator.js");
    await runLegacyTursoMigration();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(baseDir, ".turso-migrated"))).toBe(true);
  });

  it("keeps an old-acquired operation live after a progress heartbeat", async () => {
    const { acquireTursoOperationLock, assertNoTursoMigrationInProgress } = await withStorage();
    const release = acquireTursoOperationLock("test-heartbeat");
    const path = join(baseDir, ".turso-operation.lock");
    const state = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...state, timestamp: oldTimestamp() }));
    release.heartbeat();
    expect(() => assertNoTursoMigrationInProgress()).toThrow(/test-heartbeat/);
    expect(JSON.parse(readFileSync(path, "utf-8")).operation).toBe("test-heartbeat");
    release();
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an expired acquisition after same-process takeover", async () => {
    const { acquireTursoOperationLock } = await withStorage();
    const first = acquireTursoOperationLock("first");
    const path = join(baseDir, ".turso-operation.lock");
    const state = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...state, timestamp: oldTimestamp() }));
    const second = acquireTursoOperationLock("second");
    expect(() => first.heartbeat()).toThrow(/ownership lost/);
    first();
    expect(JSON.parse(readFileSync(path, "utf-8")).operation).toBe("second");
    second.heartbeat();
    second();
    expect(existsSync(path)).toBe(false);
  });

  it("refreshes legacy progress without relying on the acquisition timestamp", async () => {
    const { heartbeatTursoLock, assertNoTursoMigrationInProgress } = await withStorage();
    const path = join(baseDir, ".turso-migrate.lock");
    writeFileSync(
      path,
      JSON.stringify({ id: "legacy-test", pid: process.pid, timestamp: oldTimestamp() }, null, 2)
    );
    heartbeatTursoLock(path, "legacy-test");
    expect(() => assertNoTursoMigrationInProgress()).toThrow(/writes are temporarily blocked/);
  });

  it("aborts a heartbeat when the lock is missing, corrupt, or no longer ours", async () => {
    const { heartbeatTursoLock } = await withStorage();
    const path = join(baseDir, ".turso-migrate.lock");
    expect(() => heartbeatTursoLock(path, "test")).toThrow(/ownership lost.*aborting migration/);
    expect(existsSync(path)).toBe(false);
    for (const contents of [
      "{broken",
      JSON.stringify({ pid: 2147483647, timestamp: oldTimestamp() }),
    ]) {
      writeFileSync(path, contents);
      expect(() => heartbeatTursoLock(path, "test")).toThrow(/ownership lost.*aborting migration/);
      expect(readFileSync(path, "utf-8")).toBe(contents);
    }
  });

  it("does not release another owner's operation lock", async () => {
    const { acquireTursoOperationLock } = await withStorage();
    const release = acquireTursoOperationLock("test-release");
    const path = join(baseDir, ".turso-operation.lock");
    const contents = JSON.stringify({ pid: 2147483647, timestamp: new Date().toISOString() });
    writeFileSync(path, contents);
    release();
    expect(readFileSync(path, "utf-8")).toBe(contents);
  });

  it("logs the expired owner, age, operation, and path for audit", async () => {
    const { assertNoTursoMigrationInProgress } = await withStorage();
    const previousLogFile = process.env.OPENCODE_MEM_LOG_FILE;
    const logPath = join(baseDir, "audit.log");
    process.env.OPENCODE_MEM_LOG_FILE = logPath;
    try {
      const path = join(baseDir, ".turso-operation.lock");
      writeFileSync(
        path,
        JSON.stringify({
          pid: process.pid,
          timestamp: oldTimestamp(),
          operation: "test-audit",
        })
      );
      assertNoTursoMigrationInProgress();
      const line = readFileSync(logPath, "utf-8")
        .split("\n")
        .find((entry) => entry.includes("WARNING:"));
      expect(line).toBeDefined();
      const details = JSON.parse(line!.slice(line!.indexOf(": {") + 2));
      expect(details.pid).toBe(process.pid);
      expect(details.ageMs).toBeGreaterThan(staleMs);
      expect(details.operation).toBe("test-audit");
      expect(details.path).toBe(path);
      expect(details.removed).toBe(true);
    } finally {
      if (previousLogFile === undefined) delete process.env.OPENCODE_MEM_LOG_FILE;
      else process.env.OPENCODE_MEM_LOG_FILE = previousLogFile;
    }
  });
});
