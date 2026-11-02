import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const child = Bun.spawnSync([
  process.execPath,
  fileURLToPath(new URL("./fixtures/recall-failure-fallback.mjs", import.meta.url)),
]);
if (child.exitCode !== 0) throw new Error(child.stderr.toString());
const result = JSON.parse(child.stdout.toString());
const ids = (name: string) => result[name].memories?.map((memory: { id: string }) => memory.id);

describe("semantic recall failure fallback", () => {
  for (const name of ["failed", "thrown", "bothFailed", "bothThrown"]) {
    it(`uses recent exactly once for ${name}`, () => {
      expect(ids(name)).toEqual(["recent"]);
      expect(result[name].calls.search).toHaveLength(1);
      expect(result[name].calls.list).toHaveLength(1);
      expect(result[name].memories[0].selection).toBe("recent");
      expect(result[name].memories[0].similarity).toBeUndefined();
      expect(result[name].memories[0].sessionId).toBe("previous");
      expect(result[name].context).toContain(
        'selection="recent" id="recent" created="2026-11-01" project="project"'
      );
      expect(result[name].context).not.toContain("retrieval_score=");
    });
  }
  for (const name of ["empty", "filtered", "partialEmpty"]) {
    it(`does not replace a successful ${name} semantic result`, () => {
      expect(ids(name)).toEqual([]);
      expect(result[name].calls.list).toHaveLength(0);
    });
  }
  it("retains partial-shard semantic results and scores", () => {
    expect(ids("partial")).toEqual(["semantic"]);
    expect(result.partial.memories[0].similarity).toBe(0.75);
    expect(result.partial.memories[0].selection).toBe("semantic");
    expect(result.partial.calls.list).toHaveLength(0);
  });
  for (const name of [
    "fallbackFailed",
    "fallbackThrown",
    "bothFallbackThrown",
    "bothFailedEmpty",
  ]) {
    it(`keeps ${name} nonfatal without retrying the recent loader`, () => {
      expect(result[name].error).toBeUndefined();
      expect(ids(name)).toEqual([]);
      expect(result[name].calls.list).toHaveLength(1);
    });
  }
  for (const name of ["recent", "missingQuery", "bothMissingQuery"]) {
    it(`preserves ${name} without semantic search`, () => {
      expect(ids(name)).toEqual(["recent"]);
      expect(result[name].calls.search).toHaveLength(0);
      expect(result[name].calls.list).toHaveLength(1);
    });
  }
  it("preserves successful both fill and full-budget behavior", () => {
    expect(ids("bothEmpty")).toEqual(["recent"]);
    expect(ids("bothSuccess")).toEqual(["semantic", "recent"]);
    expect(ids("full")).toEqual(["semantic"]);
    expect(result.full.calls.list).toHaveLength(0);
  });
  for (const name of ["zero", "zeroBoth", "zeroRecent"]) {
    it(`does not load either source for ${name}`, () => {
      expect(ids(name)).toEqual([]);
      expect(result[name].calls).toEqual({ search: [], list: [] });
    });
  }
  it("passes the same count, scope, session, and age eligibility into fallback", () => {
    expect(result.failed.calls.search[0]).toEqual([
      "query",
      "project",
      "project",
      { limit: 9, similarityThreshold: 0.6 },
    ]);
    expect(result.failed.calls.list[0]).toEqual([
      "project",
      3,
      "project",
      { excludeSessionId: "session", createdAfter: Date.UTC(2026, 9, 31) },
    ]);
    expect(result.allProjects.calls.list[0][2]).toBe("all-projects");
    expect(result.explicitProject.calls.list[0][2]).toBe("project");
    expect(result.disabledFilters.calls.list[0][3]).toEqual({});
  });
});
