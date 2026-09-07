import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSqliteFileLockRetry } from "../src/services/turso/sqlite-handle-release.js";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const REAL_PLATFORM = process.platform;
function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("withSqliteFileLockRetry", () => {
  beforeAll(() => setPlatform("win32"));
  afterAll(() => setPlatform(REAL_PLATFORM));

  it("runs the operation exactly maxRetries + 1 times on a persistent lock", async () => {
    let calls = 0;
    await expect(
      withSqliteFileLockRetry(() => {
        calls += 1;
        throw errno("EBUSY");
      }, 2)
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(3);
  });

  it("runs once when maxRetries is 0", async () => {
    let calls = 0;
    await expect(
      withSqliteFileLockRetry(() => {
        calls += 1;
        throw errno("EBUSY");
      }, 0)
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(1);
  });

  it("does not retry on non-Windows platforms", async () => {
    setPlatform("linux");
    let calls = 0;
    await expect(
      withSqliteFileLockRetry(() => {
        calls += 1;
        throw errno("EBUSY");
      }, 2)
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(1);
    setPlatform("win32");
  });

  it("does not retry non-lock errors", async () => {
    let calls = 0;
    await expect(
      withSqliteFileLockRetry(() => {
        calls += 1;
        throw errno("ENOENT");
      }, 2)
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("rejects invalid maxRetries values", async () => {
    await expect(withSqliteFileLockRetry(() => "x", -1)).rejects.toThrow(TypeError);
    await expect(withSqliteFileLockRetry(() => "x", 1.5)).rejects.toThrow(TypeError);
  });

  it("returns the value when the operation eventually succeeds", async () => {
    let calls = 0;
    const value = await withSqliteFileLockRetry(() => {
      calls += 1;
      if (calls === 1) throw errno("EBUSY");
      return "ok";
    }, 2);
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("cleanupTursoTestDirectory", () => {
  it("rethrows non-lock cleanup errors", async () => {
    await expect(cleanupTursoTestDirectory("\0")).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")(
    "warns and continues when an exhausted Windows lock blocks removal",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "opencode-mem-cleanup-"));
      const db = new Database(join(dir, "locked.db"));
      const realWarn = console.warn;
      const warned: unknown[][] = [];
      console.warn = (...args: unknown[]) => warned.push(args);
      try {
        await cleanupTursoTestDirectory(dir);
      } finally {
        console.warn = realWarn;
        db.close();
      }
      expect(warned.length).toBeGreaterThan(0);
    }
  );
});
