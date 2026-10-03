/**
 * Cross-process worker for tests/profile-learning-lock.test.ts.
 *
 * Runs in a real separate process with CONFIG.storagePath mocked to a temp
 * directory, so it never touches the real memory database. All coordination
 * with the test parent uses explicit barrier files under the storage dir —
 * never sleeps — and every wait is bounded so a broken handshake fails fast
 * instead of hanging the suite.
 *
 * Env contract:
 *   PLL_STORAGE  temp storage path (also hosts the coordination DB + barriers)
 *   PLL_MODE     one of the modes below
 *
 * Modes:
 *   hold          acquire; signal hs.acquired; wait hs.release; release;
 *                 report held-before/after-release
 *   try           wait hs.acquired (winner confirmed holding), attempt acquire,
 *                 release immediately if won, report outcome
 *   hold-forever  acquire; signal hs.acquired; wait until killed (SIGKILL test)
 *   probe         single acquire attempt (live/EPERM/backdated/reuse/malformed/
 *                 db-error scenarios); release if acquired
 *   proc-probe    plant owner with pid whose /proc is absent (2^22), then
 *                 force kill(0) outcome via PLL_FORCE_KILL env (EPERM|OK|ESRCH);
 *                 report acquire result. EPERM injected by stubbing
 *                 process.kill in-process — NOT by relying on PID 1 as root.
 *   boot-variants  plant owner rows one at a time (valid-null, invalid-string,
 *                 number, object, same-as-host) and report acquire result for
 *                 each, releasing between attempts.
 *   starttime-variants  plant owner rows one at a time exercising the stored
 *                 starttime identity: strict format validation (bare
 *                 `darwin:`, garbage, malformed lstart, non-numeric junk),
 *                 cross-kind rows (a Darwin-format starttime inspected on a
 *                 Linux host and vice versa), a live owner with its real
 *                 local starttime, a null-starttime live owner (signal-probe
 *                 fallback), and a genuine same-kind mismatch (PID reuse).
 *                 Reports per case whether the lock was acquired and the
 *                 owner_token observed after the attempt, proving non-steal
 *                 cases leave the planted row untouched.
 *   darwin-sim    run the whole identity stack with process.platform forced
 *                 to "darwin" and node:child_process mocked so `ps`/`sysctl`
 *                 return controlled lstart/boottime output. Plants same-kind
 *                 Darwin owner rows — impossible dates (Oct 99, Oct 00, Feb
 *                 30, Apr 31, Feb 29 non-leap, weekday mismatch) must fail
 *                 closed while real dates (incl. leap Feb 29) stay usable,
 *                 a live owner's exact lstart is not stolen, and a different
 *                 valid lstart on a live PID is reclaimed as PID reuse.
 *                 SQL/CAS run against a real temp coordination DB.
 *   cas-race      signal hs.ready.<label>; wait hs.go; attempt acquire
 *   stale-release acquire; flip owner_token to a simulated same-PID new owner;
 *                 call the OLD release; report whether the row survived
 *   release-twice acquire; release; release again; report idempotency
 */
import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as importedFs from "node:fs";
import * as importedChildProcess from "node:child_process";
import { connect } from "@tursodatabase/database";
import { TursoDb } from "../../src/storage/turso/turso-db.js";
import { tursoExperimentalFeatures } from "../../src/storage/turso/connection-manager.js";

const storage = process.env.PLL_STORAGE;
const mode = process.env.PLL_MODE;
const label = process.env.PLL_LABEL ?? "x";
if (!storage || !mode) {
  console.error("PLL_STORAGE and PLL_MODE are required");
  process.exit(2);
}

// Captured BEFORE any mock.module call: once "node:fs" is mocked,
// re-importing inside a factory would resolve the mock and recurse.
const realReadFileSync = importedFs.readFileSync;
const realSpawnSync = importedChildProcess.spawnSync;

const configUrl = new URL("../../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../../src/infra/logger.js", import.meta.url).href;
const lockUrl = new URL("../../src/user-profile/learning-lock.js", import.meta.url).href;

mock.module(configUrl, () => ({
  CONFIG: { storagePath: storage },
  initConfig: () => {},
  isConfigured: () => true,
}));
mock.module(loggerUrl, () => ({ log: () => {} }));

// current-boot-invalid: the LOCAL machine's boot identity reads as garbage.
// The implementation must treat the local boot id as "unknown" and never use
// it as a dead signal, even against a well-formed foreign boot id. Mocks must
// be registered before learning-lock.js is imported (covers Linux /proc and
// Darwin sysctl).
if (mode === "current-boot-invalid") {
  mock.module("node:fs", () => ({
    ...importedFs,
    readFileSync: (path: any, options: any) =>
      path === "/proc/sys/kernel/random/boot_id"
        ? "not-a-boot-id"
        : realReadFileSync(path, options),
  }));
  mock.module("node:child_process", () => ({
    ...importedChildProcess,
    spawnSync: (command: any, args?: any, options?: any) => {
      if (
        command === "sysctl" &&
        Array.isArray(args) &&
        args[0] === "-n" &&
        args[1] === "kern.boottime"
      ) {
        return {
          status: 0,
          stdout: "garbage-boot-identity",
          stderr: "",
          pid: 0,
          output: [],
          signal: null,
        };
      }
      return realSpawnSync(command, args, options);
    },
  }));
}
// cas-race interleaving is driven by PLL_CAS_HOOKS=1 inside learning-lock
// (select writes token.<label>, update parks on go.update) — no client mock.
// darwin-sim: force the whole identity stack onto a simulated Darwin host.
// The platform flip and the child_process mock (controlled `ps` lstart /
// `sysctl` boottime) must be registered before learning-lock.js is imported.
// The REAL Turso DB binding was imported at module top (before any
// platform tampering), so the coordination DB stays fully real even with
// process.platform === "darwin" — only the process/child_process boundary is
// mocked, never the SQL/CAS path.
//
// PLL_LABEL selects the scenario:
//   self-lstart   PLL_STARTTIME controls the lstart returned for ANY pid
//                 (self and owner alike): the simulated host's ps answers a
//                 single controlled value, so same-kind comparisons are
//                 deterministic and weekday-consistent.
//   live-garbage  PLL_STARTTIME is returned only for THIS worker pid (self
//                 identity). Any other pid's `ps` answers a malformed lstart
//                 so the live-read path can be asserted fail-closed.
if (mode === "darwin-sim") {
  const forcedSelfLstart = process.env.PLL_STARTTIME ?? null;
  const liveGarbageForForeignPids = process.env.PLL_LABEL === "live-garbage";
  // Simulated host boot identity: sysctl kern.boottime → sec=1760000000.
  // The owner rows planted in this mode intentionally keep boot_id NULL so
  // boot comparison can never fire and the starttime paths are the only
  // ones under test.
  Object.defineProperty(process, "platform", { value: "darwin" });
  mock.module("node:child_process", () => ({
    ...importedChildProcess,
    spawnSync: (command: any, args?: any, options?: any) => {
      if (
        command === "ps" &&
        Array.isArray(args) &&
        args.includes("-o") &&
        args.includes("lstart=")
      ) {
        const pidIdx = args.indexOf("-p");
        const requestedPid = pidIdx >= 0 ? Number(args[pidIdx + 1]) : NaN;
        const stdout =
          liveGarbageForForeignPids && requestedPid !== process.pid
            ? "not-a-valid-lstart"
            : (forcedSelfLstart ?? "");
        return {
          status: 0,
          stdout,
          stderr: "",
          pid: 0,
          output: [],
          signal: null,
        };
      }
      if (
        command === "sysctl" &&
        Array.isArray(args) &&
        args[0] === "-n" &&
        args[1] === "kern.boottime"
      ) {
        return {
          status: 0,
          stdout: "{ sec = 1760000000, usec = 0 } Sat Oct  3 09:00:00 2026",
          stderr: "",
          pid: 0,
          identity: [],
          signal: null,
        };
      }
      return realSpawnSync(command, args, options);
    },
  }));
}
const lock = await import(lockUrl);

const barrier = (name: string) => join(storage, `hs.${name}`);
const WAIT_MS = 30_000;

async function waitFile(path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${path}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function signal(path: string): void {
  writeFileSync(path, "ready");
}

function out(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

async function openDb() {
  const native = await connect(join(storage, ".profile-learning-coordination.db"), {
    experimental: tursoExperimentalFeatures(),
  });
  const db = new TursoDb(native);
  await db.run("PRAGMA busy_timeout = 5000");
  return db;
}

async function readOwnerToken(): Promise<string | null> {
  const db = await openDb();
  try {
    const result = await db.execute(
      `SELECT owner_token FROM profile_learning_lock WHERE name = 'profile-learning'`
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? String(row["owner_token"]) : null;
  } finally {
    await db.close();
  }
}

/** Plants an owner row for THIS live worker pid with boot_id NULL. */
async function dbExecutePlant(
  db: TursoDb,
  caseName: string,
  starttime: string | null
): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO profile_learning_lock
            (name, owner_token, pid, boot_id, starttime, acquired_at)
          VALUES ('profile-learning', ?, ?, NULL, ?, ?)`,
    [`planted-${caseName}`, process.pid, starttime, Date.now()]
  );
}

try {
  switch (mode) {
    case "hold": {
      const release = await lock.tryAcquireProfileLearningLock("/project-hold");
      if (!release) {
        out({ acquired: false });
        break;
      }
      const heldBefore = await lock.isProfileLearningLockHeld();
      signal(barrier("acquired"));
      await waitFile(barrier("release"));
      await release();
      const heldAfter = await lock.isProfileLearningLockHeld();
      out({ acquired: true, heldBefore, heldAfter });
      break;
    }

    case "try": {
      // Do not attempt until the winner has confirmed it is holding; the
      // parent only writes hs.release after this process exits, so the
      // attempts provably overlap the winner's hold.
      await waitFile(barrier("acquired"));
      const release = await lock.tryAcquireProfileLearningLock("/project-try");
      out({ acquired: release !== null });
      if (release) await release();
      break;
    }

    case "hold-forever": {
      const release = await lock.tryAcquireProfileLearningLock("/project-forever");
      if (!release) {
        out({ acquired: false });
        break;
      }
      signal(barrier("acquired"));
      // Hold until the parent SIGKILLs this process; never release.
      await waitFile(barrier("never"));
      await release();
      break;
    }

    case "probe": {
      const release = await lock.tryAcquireProfileLearningLock("/project-probe");
      out({ acquired: release !== null });
      if (release) await release();
      break;
    }

    case "cas-race": {
      signal(barrier(`ready.${label}`));
      await waitFile(barrier("go"));
      // Inside acquire (PLL_CAS_HOOKS): INSERT fails → SELECT records
      // token.<label> → UPDATE parks on go.update, so both CAS attempts are
      // provably against the same observed stale token before either fires.
      const release = await lock.tryAcquireProfileLearningLock("/project-race");
      signal(barrier(`attempted.${label}`));
      out({ acquired: release !== null });
      if (release) {
        const peer = label === "a" ? "b" : "a";
        await waitFile(barrier(`attempted.${peer}`));
        await release();
      }
      break;
    }

    case "proc-probe": {
      // Owner pid is 2^22 (above every default pid_max → /proc absent). The
      // kill(0) outcome is forced via PLL_LABEL (EPERM | OK | ESRCH),
      // stubbed in-process — never by relying on PID 1 as root.
      const forced = label;
      if (forced === "EPERM" || forced === "OK" || forced === "ESRCH") {
        const realKill = process.kill.bind(process);
        process.kill = ((pid: number, signal?: number | string) => {
          if (pid === 4194304) {
            if (forced === "EPERM") {
              const e = new Error(`kill EPERM`) as NodeJS.ErrnoException;
              e.code = "EPERM";
              throw e;
            }
            if (forced === "ESRCH") {
              const e = new Error(`kill ESRCH`) as NodeJS.ErrnoException;
              e.code = "ESRCH";
              throw e;
            }
            return;
          }
          return realKill(pid, signal);
        }) as typeof process.kill;
      }
      const release = await lock.tryAcquireProfileLearningLock("/project-probe");
      out({ forced, acquired: release !== null });
      if (release) await release();
      break;
    }

    case "boot-variants": {
      // For each variant: plant the owner row, attempt acquire, release if
      // won. Verifies malformed boot_id fails closed while valid-null and
      // same-as-host remain live (no reclaim), all with starttime set to
      // this process's real starttime (a live, identity-verifiable owner).
      const { getProfileLearningBootId, getProfileLearningStarttime } = await import(lockUrl);
      const ownStarttime = getProfileLearningStarttime(process.pid);
      const bootFile = getProfileLearningBootId();
      if (!ownStarttime || !bootFile) {
        console.error("boot-variants requires local boot + starttime identity");
        process.exit(1);
      }
      const variants: Array<{ name: string; bootId: unknown; useRawSql?: string }> = [
        { name: "validNull", bootId: null },
        { name: "invalidString", bootId: "not-a-boot-id" },
        { name: "number", bootId: 12345 },
        // A non-string, non-null value cannot arrive via bind parameters, so
        // plant it as a BLOB: it reads back as a byte array, exercising the
        // "object-like" non-string branch of the validator.
        {
          name: "object",
          bootId: null,
          useRawSql: 'CAST(\'{"v":"x"}\' AS BLOB)',
        },
        { name: "sameAsHost", bootId: bootFile },
      ];
      const results: Record<string, boolean> = {};
      for (const v of variants) {
        const db = await openDb();
        try {
          await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
            name TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            boot_id TEXT,
            starttime TEXT,
            acquired_at INTEGER NOT NULL
          )`);
          // This worker process IS alive with a verifiable identity, so any
          // no-reclaim outcome proves the live check worked rather than a
          // parse refusal.
          if (v.useRawSql !== undefined) {
            await db.run(`INSERT OR REPLACE INTO profile_learning_lock
                    (name, owner_token, pid, boot_id, starttime, acquired_at)
                  VALUES ('profile-learning', 'planted-${v.name}', ${process.pid}, ${v.useRawSql}, '${ownStarttime}', ${Date.now()})`);
          } else {
            await db.run(
              `INSERT OR REPLACE INTO profile_learning_lock
                    (name, owner_token, pid, boot_id, starttime, acquired_at)
                  VALUES ('profile-learning', 'planted-${v.name}', ?, ?, ?, ?)`,
              [process.pid, v.bootId as string | number | null, ownStarttime, Date.now()]
            );
          }
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-boot");
        results[v.name] = release !== null;
        if (release) await release();
      }
      out({ variants: results });
      break;
    }

    case "starttime-variants": {
      // Each case plants one owner row and attempts one acquire. Cases whose
      // name ends in "-steal" assert the planted row is replaced; every other
      // case must leave the planted owner_token untouched (fail-closed).
      //
      // pid 4194304 is 2^22, above every default pid_max, so its /proc entry
      // is absent and kill(0) yields ESRCH — genuinely dead, making the
      // starttime checks the only thing standing between it and theft.
      //
      // Cases keyed to local identity use this live worker's pid. The worker
      // itself is the live holder, so a no-steal outcome proves the live
      // check engaged rather than a parse refusal.
      const cases: Array<{
        name: string;
        pid: number;
        starttime: string | null;
      }> = [
        { name: "bare-darwin-prefix", pid: 4194304, starttime: "darwin:" },
        { name: "darwin-garbage-suffix", pid: 4194304, starttime: "darwin:garbage" },
        {
          name: "darwin-malformed-lstart",
          pid: 4194304,
          starttime: "darwin:not-a-date-at-all",
        },
        {
          name: "darwin-partial-lstart",
          pid: 4194304,
          starttime: "darwin:Sat Oct 3",
        },
        {
          name: "darwin-24h-violation",
          pid: 4194304,
          starttime: "darwin:Sat Oct  3 25:61:61 2026",
        },
        { name: "empty-string", pid: 4194304, starttime: "" },
        { name: "prefix-numeric-junk", pid: 4194304, starttime: "darwin:12345" },
      ];
      // Platform-identity cases, appended only where the host provides a
      // starttime identity. "Foreign" = the OTHER platform's valid producer
      // format — well-formed, but not comparable with this host's kind, so
      // it must never generate a dead assertion on its own.
      const ownStarttime = lock.getProfileLearningStarttime(process.pid);
      if (ownStarttime) {
        const darwinHost = ownStarttime.startsWith("darwin:");
        const foreignLive = darwinHost ? "12345678" : "darwin:Sat Oct  3 09:00:00 2026";
        const foreignDead = darwinHost ? "87654321" : "darwin:Sun Nov 16 10:11:12 2025";
        const localDeadStarttime = darwinHost ? "darwin:Sun Nov 16 10:11:12 2025" : "12345678";
        cases.push(
          // The Gate 1 regression: a LIVE holder whose stored starttime is a
          // valid foreign-platform format. On upstream, the host's stat
          // comparison is always unequal across formats (numeric ticks vs
          // darwin lstart text) and the mismatch fired the PID-reuse steal.
          { name: "foreign-kind-live-owner", pid: process.pid, starttime: foreignLive },
          // Same on a provably dead PID (2^22, above every pid_max): an
          // incomparable identity still may not produce the dead assertion.
          { name: "foreign-kind-dead-pid", pid: 4194304, starttime: foreignDead },
          // Control: a LOCAL-kind starttime on a provably dead PID is the
          // normal recovery path (absent /proc → kill probe ESRCH) and must
          // still reclaim — the fix must not over-block real recovery.
          { name: "local-kind-dead-pid-steal", pid: 4194304, starttime: localDeadStarttime },
          // Live owner, its exact own starttime: never reclaimed.
          { name: "live-owner-real-starttime", pid: process.pid, starttime: ownStarttime },
          // Live owner, null starttime: the signal-probe fallback decides
          // (alive), exercising the nullable path.
          { name: "live-owner-null-starttime", pid: process.pid, starttime: null },
          // Live owner, valid local-kind starttime from a previous
          // inhabitant of this PID: legitimate PID-reuse reclaim.
          {
            name: "same-kind-mismatch-steal",
            pid: process.pid,
            starttime: darwinHost
              ? ownStarttime.replace(/\d{2}:\d{2}:\d{2}/, (t) =>
                  t === "23:59:59" ? "00:00:00" : "23:59:59"
                )
              : ownStarttime === "1"
                ? "2"
                : "1",
          }
        );
      }
      const results: Record<string, unknown> = {};
      const tokens: Record<string, string | null> = {};
      for (const c of cases) {
        const db = await openDb();
        try {
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
                  VALUES ('profile-learning', ?, ?, NULL, ?, ?)`,
            [`planted-${c.name}`, c.pid, c.starttime, Date.now()]
          );
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-starttime");
        results[c.name] = release !== null;
        tokens[c.name] = await readOwnerToken();
        if (release) await release();
      }
      out({ variants: results, tokens });
      break;
    }

    case "darwin-sim": {
      // Same-kind Darwin starttime validation on a simulated Darwin host
      // (platform forced, ps/sysctl mocked at the process boundary). Every
      // planted row is same-kind: the Linux foreign-kind guard cannot be the
      // reason any case here passes.
      //
      // Lstart calendar notes (weekday values are real, verified against the
      // UTC calendar so a rejection can only come from date validation):
      //   Sat Oct  3 09:00:00 2026   — real date, this sim's "self" value
      //   Sat Oct 99 09:00:00 2026   — day 99: impossible in October
      //   Sat Oct  0 09:00:00 2026   — day 0: impossible
      //   Sun Feb 29 09:00:00 2026   — 2026 is not a leap year
      //   Wed Feb 29 09:00:00 2028   — real leap date (Feb 29 2028 is Tue!)
      //   Tue Feb 29 09:00:00 2028   — real leap date, correct weekday
      //   Thu Apr 31 09:00:00 2027   — April has 30 days
      //   Mon Mar 32 09:00:00 2026   — day rolls into April
      //   Fri Oct  2 09:00:00 2026   — real date but Oct 2 2026 is a Friday
      //   Sun Nov 16 10:11:12 2025   — real date, different from self
      //
      // PLL_LABEL = self-lstart: the simulated ps returns PLL_STARTTIME for
      // every pid, so the "current" identity is that exact valid lstart and
      // same-kind comparisons are deterministic. Owner rows are planted on
      // THIS live worker pid with boot_id NULL.
      //
      // PLL_LABEL = live-garbage: self gets a valid lstart; foreign pids get
      // malformed ps output. A valid stored identity on an alive foreign pid
      // must NOT be stolen via the inequality path.
      if (process.env.PLL_LABEL === "live-garbage") {
        const ownStarttime = lock.getProfileLearningStarttime(process.pid);
        if (!ownStarttime) {
          console.error("live-garbage requires the simulated ps to yield a valid self lstart");
          process.exit(1);
        }
        // Prefer a definitely-alive foreign pid (init). Fall back to self+1
        // only if kill(0) on pid 1 is denied — still exercises the live-read
        // garbage path as long as the signal probe does not declare death.
        let foreignPid = 1;
        try {
          process.kill(1, 0);
        } catch {
          foreignPid = process.pid === 1 ? 2 : process.pid + 1;
          try {
            process.kill(foreignPid, 0);
          } catch {
            // Still plant: with garbage live-read the starttime path must
            // fail closed before the signal probe can reclaim.
          }
        }
        const storedValid = "darwin:Sun Nov 16 10:11:12 2025";
        const db = await openDb();
        try {
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
                  VALUES ('profile-learning', ?, ?, NULL, ?, ?)`,
            ["planted-live-ps-garbage", foreignPid, storedValid, Date.now()]
          );
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-darwin-live-garbage");
        const token = await readOwnerToken();
        if (release) await release();
        out({
          ownStarttime,
          foreignPid,
          stolen: release !== null,
          token,
        });
        break;
      }
      const ownStarttime = lock.getProfileLearningStarttime(process.pid);
      if (!ownStarttime) {
        console.error("darwin-sim requires the simulated ps to yield a valid lstart");
        process.exit(1);
      }
      const cases: Array<{ name: string; starttime: string | null; steal?: boolean }> = [
        // Impossible dates — same-kind rows that must fail closed.
        { name: "day-99", starttime: "darwin:Sat Oct 99 09:00:00 2026" },
        { name: "day-00", starttime: "darwin:Sat Oct  0 09:00:00 2026" },
        { name: "feb29-nonleap", starttime: "darwin:Sun Feb 29 09:00:00 2026" },
        { name: "apr31", starttime: "darwin:Thu Apr 31 09:00:00 2027" },
        { name: "mar32-rolls", starttime: "darwin:Mon Mar 32 09:00:00 2026" },
        { name: "weekday-mismatch", starttime: "darwin:Mon Oct  2 09:00:00 2026" },
        { name: "leap-dow-mismatch", starttime: "darwin:Wed Feb 29 09:00:00 2028" },
        { name: "empty", starttime: "" },
        { name: "garbage", starttime: "not-even-prefixed" },
        // Valid dates — must remain readable (no steal on the live owner's
        // exact identity; a different valid lstart on a live pid is the
        // simulated PID-reuse reclaim; leap Feb 29 2028 is a real date).
        { name: "exact-self", starttime: ownStarttime },
        {
          name: "valid-leap-feb29-steal",
          starttime: "darwin:Tue Feb 29 09:00:00 2028",
          steal: true,
        },
        {
          name: "valid-different-date-steal",
          starttime: "darwin:Sun Nov 16 10:11:12 2025",
          steal: true,
        },
      ];
      const results: Record<string, boolean> = {};
      const tokens: Record<string, string | null> = {};
      for (const c of cases) {
        const db = await openDb();
        try {
          await db.run(`CREATE TABLE IF NOT EXISTS profile_learning_lock (
            name TEXT PRIMARY KEY,
            owner_token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            boot_id TEXT,
            starttime TEXT,
            acquired_at INTEGER NOT NULL
          )`);
          await dbExecutePlant(db, c.name, c.starttime);
        } finally {
          await db.close();
        }
        const release = await lock.tryAcquireProfileLearningLock("/project-darwin-sim");
        results[c.name] = release !== null;
        tokens[c.name] = await readOwnerToken();
        if (release) await release();
      }
      out({ ownStarttime, variants: results, tokens });
      break;
    }

    case "current-boot-invalid": {
      // node:fs was mocked at module top (mode === "current-boot-invalid")
      // so the LOCAL boot_id reads as garbage. The planted owner is THIS
      // live worker (signal-probe OK), with a well-formed FOREIGN boot id
      // and no starttime — boot comparison is the only possible dead
      // signal, and an untrusted local boot id must never fire it.
      const db = await openDb();
      try {
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
                VALUES ('profile-learning', 'planted-other-boot', ?, '11111111-2222-3333-4444-555555555555', NULL, ?)`,
          [process.pid, Date.now()]
        );
      } finally {
        await db.close();
      }
      const release = await lock.tryAcquireProfileLearningLock("/project-boot");
      out({ acquired: release !== null });
      if (release) await release();
      break;
    }

    case "stale-release": {
      const release = await lock.tryAcquireProfileLearningLock("/project-stale");
      if (!release) {
        out({ acquired: false, stillHeld: null });
        break;
      }
      // Simulate ownership having moved on with the SAME pid but a fresh
      // token (e.g. re-claim after our death followed by pid reuse, or a
      // supervisor respawning us). The old release must not drop that row.
      const db = await openDb();
      try {
        await db.run(
          `UPDATE profile_learning_lock SET owner_token = 'simulated-new-owner-token'
                WHERE name = 'profile-learning'`
        );
      } finally {
        await db.close();
      }
      await release();
      const stillHeld = await lock.isProfileLearningLockHeld();
      out({ acquired: true, stillHeld });
      break;
    }

    case "release-twice": {
      const release = await lock.tryAcquireProfileLearningLock("/project-twice");
      if (!release) {
        out({ acquired: false });
        break;
      }
      await release();
      await release(); // Must be a no-op, not an error.
      out({ acquired: true, heldAfter: await lock.isProfileLearningLockHeld() });
      break;
    }

    default: {
      console.error(`unknown PLL_MODE: ${mode}`);
      process.exit(2);
    }
  }
} catch (error) {
  out({ error: String(error) });
  process.exit(1);
}
