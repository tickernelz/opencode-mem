import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("turso connection manager", () => {
  let baseDir: string;

  afterEach(async () => {
    const { closeTursoAndInvalidateCaches } = await import("../src/services/turso/lifecycle.js");
    await closeTursoAndInvalidateCaches();
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("deduplicates concurrent getConnection calls for the same path", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-race-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "single.db");

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");

    const [a, b, c] = await Promise.all([
      tursoConnectionManager.getConnection(dbPath),
      tursoConnectionManager.getConnection(dbPath),
      tursoConnectionManager.getConnection(dbPath),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("enables foreign keys on new connections", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-fk-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;
    const dbPath = join(baseDir, "fk.db");

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    const db = await tursoConnectionManager.getConnection(dbPath);
    const row = await db.get(`PRAGMA foreign_keys`);
    expect(Number((row as { foreign_keys?: number } | null)?.foreign_keys)).toBe(1);
  });

  it("refuses paths outside storagePath", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "turso-conn-outside-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = baseDir;

    const { tursoConnectionManager } = await import("../src/services/turso/connection-manager.js");
    await expect(
      tursoConnectionManager.getConnection(join(tmpdir(), "outside-opencode-mem.db"))
    ).rejects.toThrow(/outside storagePath/);
  });
});
