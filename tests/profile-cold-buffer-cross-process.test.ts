import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tursoConnectionManager } from "../src/storage/turso/connection-manager.js";

// Cross-process cold-buffer safety: two real, independent UserProfileManager
// instances over one shared storagePath simulate peer learning processes. All
// assertions go through the public mergeProfileData / deleteProfile surface and
// use a mocked embedding boundary (no real model download, no network LLM).
//
// Every case that should prove persistence actually triggers a save on disk —
// a merge with empty incoming arrays would never write and would pass even
// with the refresh fix removed (forbidden false coverage).

let tmpDir: string;
let coldBufferFile: string;
const extraDirs: string[] = [];

async function makeManager(dir: string = tmpDir) {
  const { CONFIG } = await import("../src/config.js");
  // Keep LLM-backed dedup/conflict checks inert (no provider configured).
  delete CONFIG.opencodeProvider;
  delete CONFIG.opencodeModel;
  delete CONFIG.memoryModel;
  delete CONFIG.memoryApiUrl;
  CONFIG.storagePath = dir;
  CONFIG.userProfileEmbeddingMinDescriptionLength = 5;
  const { UserProfileManager } = await import("../src/user-profile/user-profile-manager.js");
  return new UserProfileManager();
}

// Embedding not warmed up -> non-explicit items are buffered (cold start).
const coldEmbed = { isWarmedUp: false } as any;
// Warmed up -> buffered items drain into the merge.
const warmEmbed = {
  isWarmedUp: true,
  embed: async () => new Float32Array(8).fill(0.25),
} as any;

const empty = () => ({ preferences: [], patterns: [], workflows: [] });
const pref = (description: string) => ({ category: "style", description });
const readDisk = () => JSON.parse(readFileSync(coldBufferFile, "utf-8"));
const descs = (bucket: any) => bucket.preferences.map((p: any) => p.description);

async function coldPush(mgr: any, profileId: string, description: string) {
  // Real public merge that buffers a non-explicit item and persists it.
  await mgr.mergeProfileData(empty(), { preferences: [pref(description)] }, coldEmbed, profileId);
}

describe("cold buffer cross-process safety", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-"));
    coldBufferFile = join(tmpDir, "cold-buffer.json");
  });

  afterEach(async () => {
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    // Restore permissions first in case a failure left a read-only dir behind.
    try {
      chmodSync(tmpDir, 0o700);
    } catch {
      // ignore
    }
    for (const dir of extraDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore leftover test files
      }
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore leftover test files
    }
  });

  it("sees a peer's bucket when the file mtime is held fixed (no mtime-based refresh)", async () => {
    const a = await makeManager(); // peer process
    const b = await makeManager(); // this process

    // b persists its own bucket first, so an mtime-guarded implementation
    // would cache a "newer than the peer's write" mtime.
    await coldPush(b, "profile_B", "b own observation");
    expect(readDisk()["profile_B"].preferences).toHaveLength(1);

    // Peer writes its bucket; the file mtime is then pinned to a fixed past
    // timestamp (same-mtime / stalled-clock world).
    await coldPush(a, "profile_A", "a peer observation");
    utimesSync(coldBufferFile, 1_000_000, 1_000_000);

    // b's next merge must start from the on-disk snapshot: pushing a new
    // bucket persists the whole snapshot, so A's bucket must survive it.
    await coldPush(b, "profile_C", "c later observation");

    const disk = readDisk();
    expect(descs(disk["profile_A"])).toContain("a peer observation");
    expect(descs(disk["profile_B"])).toContain("b own observation");
    expect(descs(disk["profile_C"])).toContain("c later observation");
  });

  it("still reads peer updates when the file mtime goes backwards", async () => {
    const a = await makeManager();
    const b = await makeManager();

    await coldPush(b, "profile_B", "b first observation");
    await coldPush(a, "profile_A", "a peer observation after rollback");
    // Clock rollback: file now looks "older" than b's cached write.
    utimesSync(coldBufferFile, 1, 1);

    await coldPush(b, "profile_B", "b second observation");

    const disk = readDisk();
    expect(descs(disk["profile_A"])).toContain("a peer observation after rollback");
    expect(descs(disk["profile_B"])).toHaveLength(2);
  });

  it("does not resurrect a deleted cold-buffer file from a stale in-memory map", async () => {
    const b = await makeManager();
    await coldPush(b, "profile_GONE", "stale bucket entry that must not resurrect");
    expect(readDisk()["profile_GONE"]).toBeDefined();

    // File removed underneath us (peer cleanup / storage reset).
    unlinkSync(coldBufferFile);

    await coldPush(b, "profile_NEW", "fresh after delete");

    const disk = readDisk();
    expect(disk["profile_GONE"]).toBeUndefined();
    expect(descs(disk["profile_NEW"])).toContain("fresh after delete");
  });

  it("fails closed on a corrupt cold-buffer file instead of overwriting it", async () => {
    const b = await makeManager();
    const corrupt = "{not valid json";
    writeFileSync(coldBufferFile, corrupt, "utf-8");

    // Constructing a manager over a corrupt cache must not crash (plugin
    // import path stays fail-safe)...
    const { UserProfileManager } = await import("../src/user-profile/user-profile-manager.js");
    expect(() => new UserProfileManager()).not.toThrow();

    // ...but a merge round must refuse to treat unknown data as empty.
    await expect(
      b.mergeProfileData(
        empty(),
        { preferences: [pref("must not be persisted over unknown data")] },
        coldEmbed,
        "profile_X"
      )
    ).rejects.toThrow();
    expect(readFileSync(coldBufferFile, "utf-8")).toBe(corrupt);
  });

  it("fails closed on an empty or whitespace-only cold-buffer file", async () => {
    for (const raw of ["", "   ", "\n\t"]) {
      tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-"));
      coldBufferFile = join(tmpDir, "cold-buffer.json");
      writeFileSync(coldBufferFile, raw, "utf-8");
      try {
        const b = await makeManager();
        await expect(
          b.mergeProfileData(
            empty(),
            { preferences: [pref("never persisted")] },
            coldEmbed,
            "profile_BLANK"
          )
        ).rejects.toThrow();
        expect(readFileSync(coldBufferFile, "utf-8")).toBe(raw);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    // Recreate the beforeEach dir so afterEach cleanup stays balanced.
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-"));
    coldBufferFile = join(tmpDir, "cold-buffer.json");
  });

  it("fails closed on invalid bucket shapes without touching the file bytes", async () => {
    const invalid: Array<{ name: string; raw: string }> = [
      { name: "bucket null", raw: JSON.stringify({ profile_N: null }) },
      { name: "bucket scalar", raw: JSON.stringify({ profile_N: "oops" }) },
      {
        name: "category not an array",
        raw: JSON.stringify({ profile_N: { preferences: "nope" } }),
      },
      { name: "item null", raw: JSON.stringify({ profile_N: { preferences: [null] } }) },
      { name: "item not an object", raw: JSON.stringify({ profile_N: { patterns: [42] } }) },
      {
        name: "item without string description",
        raw: JSON.stringify({ profile_N: { workflows: [{ category: "x" }] } }),
      },
      {
        name: "legacy keys mixed with profile buckets",
        raw: JSON.stringify({ preferences: [], profile_N: { patterns: [] } }),
      },
      {
        name: "legacy category not an array",
        raw: JSON.stringify({ preferences: "not-an-array" }),
      },
    ];

    for (const { name, raw } of invalid) {
      tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-"));
      coldBufferFile = join(tmpDir, "cold-buffer.json");
      writeFileSync(coldBufferFile, raw, "utf-8");
      try {
        const b = await makeManager();
        let err: unknown;
        try {
          await b.mergeProfileData(
            empty(),
            { preferences: [pref("never persisted")] },
            coldEmbed,
            "profile_BADSHAPE"
          );
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(Error);
        expect(readFileSync(coldBufferFile, "utf-8")).toBe(raw);
        // No tmp leftovers from a failed round.
        expect(readdirSync(tmpDir).filter((f) => f.includes(".tmp"))).toHaveLength(0);
        void name;
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-"));
    coldBufferFile = join(tmpDir, "cold-buffer.json");
  });

  it("accepts a valid snapshot and a valid legacy flat file", async () => {
    // Valid per-profile snapshot loads, merges and persists without loss.
    writeFileSync(
      coldBufferFile,
      JSON.stringify({
        profile_KEEP: {
          preferences: [pref("snapshot item kept")],
          patterns: [],
          workflows: [],
        },
      }),
      "utf-8"
    );
    const b = await makeManager();
    await coldPush(b, "profile_KEEP", "second snapshot item");
    const disk = readDisk();
    expect(descs(disk["profile_KEEP"])).toContain("snapshot item kept");
    expect(descs(disk["profile_KEEP"])).toContain("second snapshot item");

    // Valid legacy flat file: accepted (dropped by documented policy), and a
    // subsequent merge persists a fresh per-profile snapshot — not rejected.
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-"));
    coldBufferFile = join(tmpDir, "cold-buffer.json");
    writeFileSync(
      coldBufferFile,
      JSON.stringify({ preferences: [pref("legacy item")], patterns: [], workflows: [] }),
      "utf-8"
    );
    const c = await makeManager();
    await coldPush(c, "profile_AFTER_LEGACY", "after legacy drop");
    const disk2 = readDisk();
    expect(descs(disk2["profile_AFTER_LEGACY"])).toContain("after legacy drop");
  });

  it("completes a save across byte-granular short writes (ascii + multibyte)", async () => {
    const run = (mode: string, dir: string, desc: string, preExisting: string) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--preload",
          join(import.meta.dir, "fixtures", "profile-cold-buffer-worker-preload.ts"),
          join(import.meta.dir, "fixtures", "profile-cold-buffer-worker-shortwrite.ts"),
          "SWMODE=" + mode,
          dir,
          "profile_SW",
          desc,
          preExisting,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = Buffer.from(result.stdout).toString("utf8").trim();
      const stderr = Buffer.from(result.stderr).toString("utf8").trim();
      const jsonLine = stdout
        .split("\n")
        .reverse()
        .find((line) => line.trim().startsWith("{"));
      if (!jsonLine) throw new Error(`worker produced no JSON: ${stderr}`);
      return { ...JSON.parse(jsonLine), stderr, exitCode: result.exitCode };
    };

    for (const mode of ["short-ascii", "short-utf8"] as const) {
      const desc =
        mode === "short-utf8" ? "用户偏好：简洁中文回答并附带代码示例" : "plain ascii observation";
      const dir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-sw-"));
      extraDirs.push(dir);
      const r = run(mode, dir, desc, "");
      expect(r.ok).toBe(true);
      expect(r.tmpLeft).toBe(0);
      // The persisted bytes must parse and round-trip the exact description —
      // a byte-offset bug would slice multi-byte chars into invalid sequences.
      const parsed = JSON.parse(r.targetBytes as string);
      expect(parsed["profile_SW"].preferences[0].description).toBe(desc);
    }
  });

  it("throws on write() returning 0 and leaves the previous target bytes intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-sw-"));
    extraDirs.push(dir);
    const preExisting = JSON.stringify({
      profile_PRE: { preferences: [pref("previous entry")], patterns: [], workflows: [] },
    });
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--preload",
        join(import.meta.dir, "fixtures", "profile-cold-buffer-worker-preload.ts"),
        join(import.meta.dir, "fixtures", "profile-cold-buffer-worker-shortwrite.ts"),
        "SWMODE=zero",
        dir,
        "profile_SW",
        "entry that cannot be written",
        preExisting,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = Buffer.from(result.stdout).toString("utf8").trim();
    const jsonLine = stdout
      .split("\n")
      .reverse()
      .find((line) => line.trim().startsWith("{"));
    if (!jsonLine) throw new Error(Buffer.from(result.stderr).toString("utf8"));
    const r = JSON.parse(jsonLine);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("write stalled");
    expect(r.targetBytes).toBe(preExisting);
    expect(r.tmpLeft).toBe(0);
  });

  it("throws on a mid-payload write error and leaves the previous target bytes intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-sw-"));
    extraDirs.push(dir);
    const preExisting = JSON.stringify({
      profile_PRE: { preferences: [pref("previous entry")], patterns: [], workflows: [] },
    });
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--preload",
        join(import.meta.dir, "fixtures", "profile-cold-buffer-worker-preload.ts"),
        join(import.meta.dir, "fixtures", "profile-cold-buffer-worker-shortwrite.ts"),
        "SWMODE=half",
        dir,
        "profile_SW",
        "entry that fails halfway through the payload",
        preExisting,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = Buffer.from(result.stdout).toString("utf8").trim();
    const jsonLine = stdout
      .split("\n")
      .reverse()
      .find((line) => line.trim().startsWith("{"));
    if (!jsonLine) throw new Error(Buffer.from(result.stderr).toString("utf8"));
    const r = JSON.parse(jsonLine);
    expect(r.ok).toBe(false);
    expect(r.targetBytes).toBe(preExisting);
    expect(r.tmpLeft).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails closed when the cold-buffer file is unreadable and leaves it untouched",
    async () => {
      const b = await makeManager();
      await coldPush(b, "profile_P", "existing peer data");
      chmodSync(coldBufferFile, 0o000);
      try {
        await expect(
          b.mergeProfileData(
            empty(),
            { preferences: [pref("must not overwrite")] },
            coldEmbed,
            "profile_Q"
          )
        ).rejects.toThrow();
      } finally {
        chmodSync(coldBufferFile, 0o600);
      }

      const disk = readDisk();
      expect(descs(disk["profile_P"])).toContain("existing peer data");
      expect(disk["profile_Q"]).toBeUndefined();
    }
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "propagates save failures without corrupting the existing file",
    async () => {
      const b = await makeManager();
      await coldPush(b, "profile_S", "already persisted entry");
      const before = readFileSync(coldBufferFile, "utf-8");

      chmodSync(tmpDir, 0o500); // dir readable but not writable -> tmp create fails
      let err: unknown;
      try {
        err = await b
          .mergeProfileData(
            empty(),
            { preferences: [pref("entry that cannot be saved")] },
            coldEmbed,
            "profile_T"
          )
          .catch((e) => e);
      } finally {
        chmodSync(tmpDir, 0o700);
      }

      expect(err).toBeInstanceOf(Error);
      // Atomic write: the failed round leaves the previous content intact.
      expect(readFileSync(coldBufferFile, "utf-8")).toBe(before);
      // A later successful round persists new data without losing the old.
      await coldPush(b, "profile_T", "retry entry");
      const disk = readDisk();
      expect(descs(disk["profile_T"])).toContain("retry entry");
      expect(descs(disk["profile_S"])).toContain("already persisted entry");
    }
  );

  it("keeps every pending buffer mutation from one merge round on disk", async () => {
    const b = await makeManager();
    await b.mergeProfileData(
      empty(),
      {
        preferences: [pref("pref observation")],
        patterns: [{ category: "style", description: "pattern observation" }],
        workflows: [{ category: "style", description: "workflow observation" }],
      },
      coldEmbed,
      "profile_MULTI"
    );

    const bucket = readDisk()["profile_MULTI"];
    expect(bucket.preferences).toHaveLength(1);
    expect(bucket.patterns).toHaveLength(1);
    expect(bucket.workflows).toHaveLength(1);
  });

  it("reset() drops the previous storage's buckets instead of writing them to the new storage", async () => {
    const { CONFIG } = await import("../src/config.js");
    const dir2 = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-xproc-2-"));
    extraDirs.push(dir2);

    const b = await makeManager(tmpDir);
    await coldPush(b, "profile_OLD", "belongs to the old storage");
    expect(readFileSync(join(tmpDir, "cold-buffer.json"), "utf-8")).toContain("profile_OLD");

    CONFIG.storagePath = dir2;
    b.reset();
    await coldPush(b, "profile_NEW", "belongs to the new storage");

    const disk2 = JSON.parse(readFileSync(join(dir2, "cold-buffer.json"), "utf-8"));
    expect(descs(disk2["profile_NEW"])).toContain("belongs to the new storage");
    expect(disk2["profile_OLD"]).toBeUndefined();
  });

  it("deleteProfile removes the bucket from the current on-disk snapshot", async () => {
    const a = await makeManager();
    const b = await makeManager(); // constructed before any file exists
    await coldPush(a, "profile_KEEP", "kept bucket");
    await coldPush(a, "profile_DOOM", "doomed bucket");

    await b.deleteProfile("profile_DOOM");

    const disk = readDisk();
    expect(disk["profile_DOOM"]).toBeUndefined();
    expect(descs(disk["profile_KEEP"])).toContain("kept bucket");
  });

  it("a warm merge drains a peer-buffered bucket through the real merge path", async () => {
    const a = await makeManager(); // peer buffers while its embedding is cold
    const b = await makeManager();

    await coldPush(a, "profile_W", "peer buffered a warm-drainable observation");
    // Peer file mtime pinned in the past must not hide the bucket from b.
    utimesSync(coldBufferFile, 1_000_000, 1_000_000);

    const merged = await b.mergeProfileData(empty(), { preferences: [] }, warmEmbed, "profile_W");
    expect(descs(merged)).toContain("peer buffered a warm-drainable observation");
    // Drained bucket is empty when persisted -> omitted from disk, not resurrected.
    expect(readDisk()["profile_W"]).toBeUndefined();
  });
});
