import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { TursoDb } from "../src/storage/turso/turso-db.js";
import {
  PROFILE_LEARNING_COORDINATION_DB,
  getProfileLearningBootId,
  getProfileLearningStarttime,
} from "../src/user-profile/learning-lock.js";
import { tursoExperimentalFeatures } from "../src/storage/turso/connection-manager.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

const WORKER = join(import.meta.dir, "fixtures", "profile-learning-lock-worker.mts");
const LOCAL_BOOT_ID = getProfileLearningBootId();
const LOCAL_START_TIME = getProfileLearningStarttime(process.pid);
const HAS_BOOT_IDENTITY = LOCAL_BOOT_ID !== null;
const HAS_START_IDENTITY = LOCAL_START_TIME !== null;

function storage(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-learning-lock-"));
  tempDirs.push(dir);
  return dir;
}

function barrierPath(dir: string, name: string): string {
  return join(dir, `hs.${name}`);
}

async function waitBarrier(dir: string, name: string, timeoutMs = 30_000): Promise<void> {
  const path = barrierPath(dir, name);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface WorkerResult {
  exitCode: number | null;
  stderr: string;
  parsed: Record<string, unknown> | null;
}

interface WorkerProc {
  result: Promise<WorkerResult>;
  kill: (signal?: number | string) => void;
  exited: Promise<number>;
}

function spawnWorker(
  dir: string,
  mode: string,
  label = "x",
  extraEnv: Record<string, string> = {}
): WorkerProc {
  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER],
    env: {
      ...process.env,
      PLL_STORAGE: dir,
      PLL_MODE: mode,
      PLL_LABEL: label,
      ...(mode === "cas-race" ? { PLL_CAS_HOOKS: "1" } : {}),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = (async (): Promise<WorkerResult> => {
    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = (await new Response(proc.stderr).text()).trim();
    const exitCode = await proc.exited;
    let parsed: Record<string, unknown> | null = null;
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last) {
      try {
        parsed = JSON.parse(last) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { exitCode, stderr, parsed };
  })();
  return {
    result,
    kill: (signal?: number | string) => proc.kill(signal ?? ("SIGKILL" as const)),
    exited: proc.exited,
  };
}

async function runProbe(dir: string): Promise<WorkerResult> {
  const worker = spawnWorker(dir, "probe");
  return worker.result;
}

/** Opens the coordination DB directly (fixture setup / assertions). */
async function withDb<T>(dir: string, fn: (db: TursoDb) => Promise<T>): Promise<T> {
  const native = await connect(join(dir, PROFILE_LEARNING_COORDINATION_DB), {
    experimental: tursoExperimentalFeatures(),
  });
  const db = new TursoDb(native);
  try {
    await db.run("PRAGMA busy_timeout = 5000");
    return await fn(db);
  } finally {
    await db.close();
  }
}

interface PlantedOwner {
  ownerToken?: string;
  pid: number;
  bootId?: string | null;
  starttime?: string | null;
  acquiredAt?: number;
}

async function plantOwner(dir: string, owner: PlantedOwner): Promise<void> {
  await withDb(dir, async (db) => {
    await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
      name TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      pid INTEGER NOT NULL,
      boot_id TEXT,
      starttime TEXT,
      acquired_at INTEGER NOT NULL
    )`);
    await db.run(
      `INSERT OR REPLACE INTO profile_learning_lock
              (name, owner_token, pid, boot_id, starttime, acquired_at)
            VALUES ('profile-learning', ?, ?, ?, ?, ?)`,
      [
        owner.ownerToken ?? "planted-owner-token",
        owner.pid,
        owner.bootId ?? null,
        owner.starttime ?? null,
        owner.acquiredAt ?? Date.now(),
      ]
    );
    // Flush WAL so freshly spawned workers always see the planted row.
    await db.run(`PRAGMA wal_checkpoint(TRUNCATE)`);
  });
}

function readBootId(): string {
  if (!LOCAL_BOOT_ID) {
    throw new Error("no local boot identity on this platform");
  }
  return LOCAL_BOOT_ID;
}

function readStarttime(pid: number): string {
  const starttime = getProfileLearningStarttime(pid);
  if (!starttime) {
    throw new Error(`no starttime identity for pid ${pid} on this platform`);
  }
  return starttime;
}

/**
 * A VALID current-platform starttime that is simply not this process's:
 * numeric ticks on Linux ("1" — a real field-22 value no modern process
 * has), or a real calendar date behind the darwin prefix on Darwin. Kind is
 * always the local one so the same-kind mismatch path is exercised.
 */
function localKindMismatchStarttime(): string {
  if (LOCAL_START_TIME?.startsWith("darwin:")) {
    return "darwin:Sun Nov 16 10:11:12 2025";
  }
  return "1";
}

/**
 * A VALID current-platform starttime for a dead-pid row: same kind as the
 * host's, well-formed, but guaranteed to differ from anything the host
 * could read for a live process (used with pid 4194304, which is above
 * every default pid_max and therefore never alive).
 */
function localKindDeadPidStarttime(): string {
  if (LOCAL_START_TIME?.startsWith("darwin:")) {
    return "darwin:Sun Nov 16 10:11:12 2025";
  }
  return "12345678";
}

async function currentOwnerToken(dir: string): Promise<string | null> {
  return withDb(dir, async (db) => {
    const row = await db.get(
      `SELECT owner_token FROM profile_learning_lock WHERE name = 'profile-learning'`
    );
    return row ? String(row["owner_token"]) : null;
  });
}

describe("cross-process profile learning lock (SQL coordination DB)", () => {
  it("grants the lock to exactly one process and release frees it for the next", async () => {
    const dir = storage();

    const winner = spawnWorker(dir, "hold");
    // Only attempt once the winner has confirmed it is holding.
    await waitBarrier(dir, "acquired");

    const loser = spawnWorker(dir, "try");
    // The loser's attempt fully completes (process exits) before release.
    const loserResult = await loser.result;
    expect(loserResult.exitCode).toBe(0);
    expect(loserResult.parsed).toEqual({ acquired: false });

    writeFileSync(barrierPath(dir, "release"), "ready");
    const winnerResult = await winner.result;
    expect(winnerResult.exitCode).toBe(0);
    // held before release, not held after — and heldBefore is the winner's
    // own row, not a leftover from a previous owner.
    expect(winnerResult.parsed).toEqual({ acquired: true, heldBefore: true, heldAfter: false });

    // The freed lock is acquirable again.
    const again = await runProbe(dir);
    expect(again.parsed).toEqual({ acquired: true });
  }, 45_000);

  it("release is idempotent", async () => {
    const dir = storage();
    const result = await spawnWorker(dir, "release-twice").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true, heldAfter: false });
  }, 30_000);

  it("never steals a live lock, even held past 30 minutes", async () => {
    const dir = storage();
    // This test process is alive and its identity is fully verifiable, so
    // the lock is live under any reading. The age must play no role.
    await plantOwner(dir, {
      pid: process.pid,
      bootId: HAS_BOOT_IDENTITY ? readBootId() : null,
      starttime: HAS_START_IDENTITY ? readStarttime(process.pid) : null,
      acquiredAt: Date.now() - 31 * 60 * 1000,
    });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
    // The live owner's row is untouched.
    expect(await currentOwnerToken(dir)).toBe("planted-owner-token");
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "never steals a lock owned by a process we cannot signal (EPERM)",
    async () => {
      const dir = storage();
      // PID 1 is alive and owned by root; kill(1, 0) yields EPERM for a
      // non-root caller. No startup identity is recorded, so the
      // implementation must fall back to the signal probe and treat EPERM
      // as "alive, not reclaimable". Windows has no equivalent protected
      // PID 1 semantics (PID 1 is typically ESRCH), so this probe is Unix-only.
      await plantOwner(dir, { pid: 1, starttime: null, acquiredAt: Date.now() });

      const result = await runProbe(dir);
      expect(result.exitCode).toBe(0);
      expect(result.parsed).toEqual({ acquired: false });
      expect(await currentOwnerToken(dir)).toBe("planted-owner-token");
    },
    30_000
  );

  it("exactly one of two competitors CAS-reclaims the same dead owner", async () => {
    const dir = storage();
    // 2^22 exceeds every default Linux pid_max, so it can never be live.
    await plantOwner(dir, { pid: 4194304, acquiredAt: Date.now() });

    const a = spawnWorker(dir, "cas-race", "a");
    const b = spawnWorker(dir, "cas-race", "b");
    await waitBarrier(dir, "ready.a");
    await waitBarrier(dir, "ready.b");
    writeFileSync(barrierPath(dir, "go"), "ready");

    // Both sides must have observed the SAME stale owner token before
    // either CAS fires; PLL_CAS_HOOKS parks each UPDATE until go.update,
    // making the shared-snapshot precondition deterministic.
    try {
      await waitBarrier(dir, "seen.a");
      await waitBarrier(dir, "seen.b");
    } catch (error) {
      const [ra, rb] = await Promise.all([a.result, b.result]);
      throw new Error(
        `${String(error)}\n` +
          `a: exit=${ra.exitCode} out=${JSON.stringify(ra.parsed)} err=${ra.stderr}\n` +
          `b: exit=${rb.exitCode} out=${JSON.stringify(rb.parsed)} err=${rb.stderr}\n` +
          `barriers=${readdirSync(dir)
            .filter((name) => name.startsWith("hs."))
            .sort()
            .join(",")}`,
        { cause: error }
      );
    }
    const tokenA = readFileSync(barrierPath(dir, "token.a"), "utf-8");
    const tokenB = readFileSync(barrierPath(dir, "token.b"), "utf-8");
    expect(tokenA).toBe(tokenB);
    expect(tokenA).toBe("planted-owner-token");
    writeFileSync(barrierPath(dir, "go.update"), "ready");

    const [ra, rb] = await Promise.all([a.result, b.result]);
    expect(ra.exitCode).toBe(0);
    expect(rb.exitCode).toBe(0);
    // CAS on the same observed old owner_token: exactly one UPDATE wins.
    const acquired = [ra.parsed?.["acquired"], rb.parsed?.["acquired"]].filter(Boolean);
    expect(acquired).toHaveLength(1);
    // The winner released on exit, so the lock is free again.
    expect(await currentOwnerToken(dir)).toBeNull();
  }, 60_000);

  it("a stale release cannot drop a new owner's row, even with the same PID", async () => {
    const dir = storage();
    const result = await spawnWorker(dir, "stale-release").result;
    expect(result.exitCode).toBe(0);
    // acquired:true means the old token was valid at release time, and
    // stillHeld:true means the simulated new owner's row survived the old
    // release (DELETE is conditional on the owner token).
    expect(result.parsed).toEqual({ acquired: true, stillHeld: true });
    expect(await currentOwnerToken(dir)).toBe("simulated-new-owner-token");
  }, 30_000);

  it("recovers the lock after the holder is SIGKILLed without releasing", async () => {
    const dir = storage();
    const holder = spawnWorker(dir, "hold-forever");
    await waitBarrier(dir, "acquired");

    holder.kill("SIGKILL");
    await holder.exited;

    // The killed process is provably gone (/proc/<pid> absent), so a new
    // process must be able to take over.
    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true });
  }, 45_000);

  it("reclaims a live PID only when the startup identity differs (PID reuse)", async () => {
    // Requires a platform starttime identity (Linux /proc or Darwin ps).
    if (!HAS_START_IDENTITY) return;

    const dir = storage();
    // This test process is alive, but the recorded starttime belongs to a
    // previous inhabitant of this PID — reuse must be detected by identity,
    // not by age (acquired_at is fresh). The planted value must be a VALID
    // current-platform starttime (kind guard makes a foreign-format value a
    // non-comparable no-steal row, which is covered separately; this case
    // exercises the same-kind mismatch path).
    await plantOwner(dir, {
      pid: process.pid,
      bootId: HAS_BOOT_IDENTITY ? readBootId() : null,
      starttime: localKindMismatchStarttime(),
      acquiredAt: Date.now(),
    });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true });
    expect(await currentOwnerToken(dir)).toBeNull();
  }, 30_000);

  it("reclaims an owner from a previous boot even though its PID is alive now", async () => {
    // Requires a platform boot identity (Linux boot_id or Darwin kern.boottime).
    if (!HAS_BOOT_IDENTITY) return;

    const dir = storage();
    await plantOwner(dir, {
      pid: process.pid,
      bootId: "00000000-0000-0000-0000-000000000000",
      starttime: HAS_START_IDENTITY ? readStarttime(process.pid) : null,
      acquiredAt: Date.now(),
    });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: true });
  }, 30_000);

  it("fails closed on malformed coordination state", async () => {
    const dir = storage();
    // pid 0 can never identify a process; the record is structurally
    // invalid and must be treated as untrustworthy, not as a free lock.
    await plantOwner(dir, { pid: 0, acquiredAt: Date.now() });

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
    expect(await currentOwnerToken(dir)).toBe("planted-owner-token");
  }, 30_000);

  it("proc ENOENT alone never kills; only the kill probe decides", async () => {
    // Owner pid 4194304 → /proc/<pid>/stat absent in every environment.
    // A non-null CURRENT-PLATFORM-KIND starttime makes the checker take the
    // proc-stat branch and hit the absent → kill-probe fallthrough for real
    // (a null starttime would take the direct signal-probe path instead,
    // and a foreign-kind value would correctly no-steal via the kind guard
    // — neither exercises this path).
    // PLL_LABEL injects the exact kill(0) outcome in-process:
    //   EPERM (hidepid=2 live holder) → false
    //   OK    (live)                   → false
    //   ESRCH (dead)                   → true (reclaimed)
    const outcomes: Record<string, boolean> = {};
    for (const forced of ["EPERM", "OK", "ESRCH"] as const) {
      const caseDir = storage();
      await plantOwner(caseDir, {
        pid: 4194304,
        starttime: localKindDeadPidStarttime(),
        acquiredAt: Date.now(),
      });
      const worker = spawnWorker(caseDir, "proc-probe", forced);
      const result = await worker.result;
      expect(result.exitCode).toBe(0);
      expect(result.parsed).toEqual({ forced, acquired: forced === "ESRCH" });
      outcomes[forced] = Boolean(result.parsed?.["acquired"]);
    }
    expect(outcomes).toEqual({ EPERM: false, OK: false, ESRCH: true });
  }, 60_000);

  it("boot_id variants: malformed fails closed; valid-null and same-as-host stay live", async () => {
    // Worker reads the local boot/starttime identity; skip where unavailable.
    if (!HAS_BOOT_IDENTITY || !HAS_START_IDENTITY) return;

    const dir = storage();
    const result = await spawnWorker(dir, "boot-variants").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.["variants"]).toEqual({
      validNull: false,
      invalidString: false,
      number: false,
      object: false,
      sameAsHost: false,
    });
  }, 60_000);

  it("stored starttime identity: strict format, cross-kind never kills, only same-kind mismatch reclaims", async () => {
    // Worker plants each owner row variant and attempts one acquire.
    // The key cases here are upstream regressions Oracle flagged in Gate 1:
    // a Linux host must not CAS-steal a live owner merely because its stored
    // starttime carries the darwin: prefix and therefore "differs" from the
    // host's numeric /proc starttime; malformed prefixed values (bare
    // `darwin:`, `darwin:garbage`) must fail closed at parse time.
    const dir = storage();
    const result = await spawnWorker(dir, "starttime-variants").result;
    expect(result.exitCode).toBe(0);
    const variants = result.parsed?.["variants"] as Record<string, boolean>;
    const tokens = result.parsed?.["tokens"] as Record<string, string | null>;

    // Format validation: fail closed, planted row untouched.
    for (const name of [
      "bare-darwin-prefix",
      "darwin-garbage-suffix",
      "darwin-malformed-lstart",
      "darwin-partial-lstart",
      "darwin-24h-violation",
      "empty-string",
      "prefix-numeric-junk",
    ]) {
      expect(variants[name]).toBe(false);
      expect(tokens[name]).toBe(`planted-${name}`);
    }

    // Platform-identity-gated cases (only present when host provides one).
    if ("live-owner-real-starttime" in variants) {
      // The Gate 1 regression: a live holder with a valid foreign-platform
      // starttime must never be CAS-stolen via a bogus "PID reuse" mismatch.
      expect(variants["foreign-kind-live-owner"]).toBe(false);
      expect(tokens["foreign-kind-live-owner"]).toBe("planted-foreign-kind-live-owner");
      // Incomparable identity on a dead PID still never asserts death by
      // itself (the lock simply is not reclaimed through this row).
      expect(variants["foreign-kind-dead-pid"]).toBe(false);
      expect(tokens["foreign-kind-dead-pid"]).toBe("planted-foreign-kind-dead-pid");
      // Control: same-kind identity on a genuinely dead PID must still
      // recover the lock (fix must not over-block legitimate recovery).
      expect(variants["local-kind-dead-pid-steal"]).toBe(true);
      // Live owner with its exact own starttime: never reclaimed.
      expect(variants["live-owner-real-starttime"]).toBe(false);
      expect(tokens["live-owner-real-starttime"]).toBe("planted-live-owner-real-starttime");
      // Null starttime on a live owner: signal-probe fallback decides alive.
      expect(variants["live-owner-null-starttime"]).toBe(false);
      expect(tokens["live-owner-null-starttime"]).toBe("planted-live-owner-null-starttime");
      // Valid local-kind starttime of a previous PID inhabitant: reclaim.
      expect(variants["same-kind-mismatch-steal"]).toBe(true);
    }
  }, 180_000);

  it.skipIf(process.platform === "win32")(
    "same-kind Darwin starttime: impossible dates fail closed, real dates stay usable (simulated darwin host)",
    async () => {
      // Runs on Linux/macOS hosts: the child fixture forces process.platform=
      // "darwin" and mocks ONLY the ps/sysctl boundary (real Turso driver
      // imported before the flip; SQL/CAS run against a real temp coordination
      // DB). The mocked ps answers one controlled valid lstart
      // ("Sat Oct  3 09:00:00 2026") — real calendar date — for every pid, so
      // self identity is same-kind and deterministic. Nothing here can pass via
      // the Linux foreign-kind guard. Skipped on Windows: Bun cannot reliably
      // force a Darwin identity stack there (platform/ps boundary).
      const dir = storage();
      const worker = spawnWorker(dir, "darwin-sim", "self-lstart", {
        PLL_STARTTIME: "Sat Oct  3 09:00:00 2026",
      });
      const result = await worker.result;
      expect([result.exitCode, result.stderr]).toEqual([0, ""]);
      const own = result.parsed?.["ownStarttime"];
      expect(own).toBe("darwin:Sat Oct  3 09:00:00 2026");
      const variants = result.parsed?.["variants"] as Record<string, boolean>;
      const tokens = result.parsed?.["tokens"] as Record<string, string | null>;

      // Impossible calendar values behind a structurally matching prefix:
      // every one parses under the attempt-1 regex ((\d{1,2}) admits 00/99,
      // no month-length/leap/weekday logic) and would CAS-steal the live row.
      for (const name of [
        "day-99",
        "day-00",
        "feb29-nonleap", // 2026-02-29 rolls to Mar 1 (a Sunday!) — only the
        // day-rollover check catches this one, not the weekday check
        "apr31",
        "mar32-rolls",
        "weekday-mismatch", // real date Oct 2 2026, wrong weekday (Fri)
        "leap-dow-mismatch", // real leap date Feb 29 2028, wrong weekday (Tue)
        "empty",
        "garbage",
      ]) {
        expect(variants[name]).toBe(false);
        expect(tokens[name]).toBe(`planted-${name}`);
      }

      // Real dates must remain readable identities:
      //  - the live owner's exact lstart is never stolen;
      //  - leap Feb 29 2028 with its correct weekday is a valid different
      //    identity → simulated PID-reuse reclaim;
      //  - any other real date likewise reclaims.
      expect(variants["exact-self"]).toBe(false);
      expect(tokens["exact-self"]).toBe("planted-exact-self");
      expect(variants["valid-leap-feb29-steal"]).toBe(true);
      expect(variants["valid-different-date-steal"]).toBe(true);
    },
    120_000
  );

  it.skipIf(process.platform === "win32")(
    "live Darwin ps garbage against a valid stored identity must not steal (simulated)",
    async () => {
      // Self identity is a valid lstart; the foreign owner's live `ps` returns
      // malformed text. Without live-read validation, inequality would CAS-steal.
      // Same Windows skip as the companion darwin-sim calendar suite above.
      const dir = storage();
      const worker = spawnWorker(dir, "darwin-sim", "live-garbage", {
        PLL_STARTTIME: "Sat Oct  3 09:00:00 2026",
      });
      const result = await worker.result;
      expect([result.exitCode, result.stderr]).toEqual([0, ""]);
      expect(result.parsed?.["ownStarttime"]).toBe("darwin:Sat Oct  3 09:00:00 2026");
      expect(result.parsed?.["stolen"]).toBe(false);
      expect(result.parsed?.["token"]).toBe("planted-live-ps-garbage");
    },
    60_000
  );

  it("an untrusted local boot_id never acts as a dead signal", async () => {
    // Worker forces the local boot identity reader to return garbage.
    if (!HAS_BOOT_IDENTITY) return;

    const dir = storage();
    const result = await spawnWorker(dir, "current-boot-invalid").result;
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
  }, 30_000);

  it("fails closed when the coordination database cannot be opened", async () => {
    const dir = storage();
    // A directory where the DB file should be makes every statement fail;
    // acquisition must degrade to null (skip this round), not throw.
    mkdirSync(join(dir, PROFILE_LEARNING_COORDINATION_DB));

    const result = await runProbe(dir);
    expect(result.exitCode).toBe(0);
    expect(result.parsed).toEqual({ acquired: false });
  }, 30_000);
});
