import { afterEach, describe, expect, it } from "bun:test";
import { connect } from "@tursodatabase/database";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTursoTestDirectory } from "./turso-test-utils.js";

describe("turso multiprocess_wal", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("buildConnectOptions enables encryption and multiprocess_wal on Unix only", async () => {
    const { buildConnectOptions, tursoExperimentalFeatures, supportsTursoMultiprocessWal } =
      await import("../src/storage/turso/connection-manager.js");
    expect(tursoExperimentalFeatures("linux")).toEqual(["encryption", "multiprocess_wal"]);
    expect(tursoExperimentalFeatures("darwin")).toEqual(["encryption", "multiprocess_wal"]);
    expect(tursoExperimentalFeatures("win32")).toEqual(["encryption"]);
    expect(supportsTursoMultiprocessWal("win32")).toBe(false);
    expect(buildConnectOptions()).toEqual({
      experimental: tursoExperimentalFeatures(),
    });
    expect(buildConnectOptions({ cipher: "aes256gcm", hexkey: "aa".repeat(32) })).toMatchObject({
      experimental: tursoExperimentalFeatures(),
      encryption: { cipher: "aes256gcm" },
    });
  });

  it("wrapTursoOpenError explains multi-process lock failures", async () => {
    const { wrapTursoOpenError, isTursoMultiProcessLockError } =
      await import("../src/storage/turso/connection-manager.js");
    const locked = new Error(
      "failed to open database /tmp/x.db: Locking error: Failed locking file. File is locked by another process"
    );
    expect(isTursoMultiProcessLockError(locked)).toBe(true);
    const wrapped = wrapTursoOpenError("/tmp/x.db", locked);
    expect(wrapped.message).toMatch(/Failed to open database \/tmp\/x\.db/);
    expect(wrapped.message).toMatch(/OpenCode session|single-owner|multiprocess_wal/i);
  });

  it.skipIf(process.platform === "win32")(
    "allows two concurrent opens with multiprocess_wal",
    async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-mp-share-"));
      const { CONFIG } = await import("../src/config.js");
      CONFIG.storagePath = baseDir;
      CONFIG.databaseEncryptionEnabled = false;
      const { buildConnectOptions } = await import("../src/storage/turso/connection-manager.js");

      const dbPath = join(baseDir, "shared.db");
      const opts = buildConnectOptions();
      const first = await connect(dbPath, opts);
      try {
        await first.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);");
        const second = await connect(dbPath, opts);
        try {
          const rows = await second.all("SELECT x FROM t");
          expect(rows).toEqual([{ x: 1 }]);
          expect(existsSync(`${dbPath}-tshm`) || existsSync(`${dbPath}-wal`)).toBe(true);
        } finally {
          await second.close();
        }
      } finally {
        await first.close();
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects a second process exclusive open without multiprocess_wal",
    async () => {
      baseDir = mkdtempSync(join(tmpdir(), "turso-mp-excl-"));
      const dbPath = join(baseDir, "exclusive.db");
      const exclusiveOpts = { experimental: ["encryption" as const] };
      const first = await connect(dbPath, exclusiveOpts);
      try {
        await first.exec("CREATE TABLE t(x INTEGER);");

        const { spawnSync } = await import("node:child_process");
        const script = `
          import { connect } from "@tursodatabase/database";
          const db = await connect(${JSON.stringify(dbPath)}, { experimental: ["encryption"] });
          await db.close();
        `;
        const child = spawnSync(process.execPath, ["--eval", script], {
          encoding: "utf-8",
          timeout: 15_000,
        });
        expect(child.status).not.toBe(0);
        expect(`${child.stderr}\n${child.stdout}`).toMatch(
          /locked by another process|Locking error/i
        );
      } finally {
        await first.close();
      }
    }
  );
});

describe("sqlite sidecars include -tshm", () => {
  let baseDir: string;

  afterEach(async () => {
    await cleanupTursoTestDirectory(baseDir);
  });

  it("rename/copy/remove move -wal -shm and -tshm together", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-tshm-"));
    const { copySqliteDatabase, renameSqliteDatabase, removeSqliteDatabase } =
      await import("../src/storage/turso/sqlite-handle-release.js");

    const src = join(baseDir, "src.db");
    const dst = join(baseDir, "dst.db");
    const renamed = join(baseDir, "renamed.db");
    writeFileSync(src, "main");
    writeFileSync(`${src}-wal`, "wal");
    writeFileSync(`${src}-shm`, "shm");
    writeFileSync(`${src}-tshm`, "tshm");

    copySqliteDatabase(src, dst);
    expect(existsSync(dst)).toBe(true);
    expect(existsSync(`${dst}-wal`)).toBe(true);
    expect(existsSync(`${dst}-shm`)).toBe(true);
    expect(existsSync(`${dst}-tshm`)).toBe(true);

    renameSqliteDatabase(dst, renamed);
    expect(existsSync(renamed)).toBe(true);
    expect(existsSync(`${renamed}-tshm`)).toBe(true);
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(`${dst}-tshm`)).toBe(false);

    removeSqliteDatabase(renamed);
    expect(existsSync(renamed)).toBe(false);
    expect(existsSync(`${renamed}-wal`)).toBe(false);
    expect(existsSync(`${renamed}-shm`)).toBe(false);
    expect(existsSync(`${renamed}-tshm`)).toBe(false);
  });
});
