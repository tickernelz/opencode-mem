import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "opencode-mem-injection-eligibility-"));
let result: {
  loaded: string[];
  v1: string[];
  readSizes: number[];
  ordinaryList: string[];
  unfiltered: string[];
  multishard: string[];
  multishardReadSizes: number[];
  ageFiltered: string[];
  ageDisabled: string[];
  pinned: string[];
  crossPinned: string[];
  metadata: string[];
  fewer: string[];
  zero: string;
  none: string;
};

afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeAll(() => {
  // Keep module mocks and native connections isolated from the rest of the suite.
  const child = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("./fixtures/memory-injection-eligibility.mjs", import.meta.url)),
    directory,
  ]);
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  result = JSON.parse(child.stdout.toString().trim());
});

describe("memory injection eligibility", () => {
  it("fills the V2 context limit with older eligible memories", () => {
    expect(result.loaded).toEqual(["eligible-0", "eligible-1", "eligible-2"]);
  });

  it("fills V1 synthetic context using the same eligible memories", () => {
    expect(result.v1).toEqual(["eligible-0", "eligible-1", "eligible-2"]);
  });

  it("leaves ordinary listing and disabled session exclusion unchanged", () => {
    expect(result.ordinaryList).toEqual(["excluded-0", "excluded-1", "excluded-2"]);
    expect(result.unfiltered).toEqual(result.ordinaryList);
  });

  it("filters each shard before limiting and merges only the current project", () => {
    expect(result.multishard).toEqual(["eligible-a", "eligible-c", "eligible-b"]);
    expect(result.readSizes.length).toBeGreaterThan(0);
    expect(result.multishardReadSizes.length).toBe(2);
    for (const count of [...result.readSizes, ...result.multishardReadSizes]) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it("preserves the strict age cutoff and permits disabling it", () => {
    expect(result.ageFiltered).toEqual(["recent"]);
    expect(result.ageDisabled).toEqual(["recent", "cutoff", "too-old-pinned"]);
  });

  it("preserves existing pinned selection and recency ordering", () => {
    expect(result.pinned).toEqual(["recent-0", "recent-1", "pinned"]);
  });

  it("keeps pinned memories when merging shard limits", () => {
    expect(result.crossPinned).toEqual(["shard1-newest", "shard1-newer", "cross-pinned"]);
  });

  it("excludes by session_id with metadata fallback for legacy rows", () => {
    // session_id wins when set (missing-metadata, session-column-only); legacy
    // metadata.sessionID still excludes; malformed/null session stays eligible.
    expect(result.metadata).toEqual(["malformed", "different-session"]);
  });

  it("returns fewer memories when fewer are eligible", () => {
    expect(result.fewer).toEqual(["only-eligible"]);
  });

  it("preserves profile-only context when the limit is zero or all memories are excluded", () => {
    for (const text of [result.zero, result.none]) {
      expect(text).toContain("<user_profile>");
      expect(text).toContain("Synthetic profile preference");
      expect(text).not.toContain("<project_knowledge>");
    }
  });
});
