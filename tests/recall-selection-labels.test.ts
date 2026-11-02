import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const child = Bun.spawnSync([
  process.execPath,
  fileURLToPath(new URL("./fixtures/recall-selection-labels.mjs", import.meta.url)),
]);
if (child.exitCode !== 0) throw new Error(child.stderr.toString());
const result = JSON.parse(child.stdout.toString());

describe("recall selection labels", () => {
  for (const mode of ["recent", "fallback", "bothFallback"]) {
    it(`does not invent a score for ${mode}`, () => {
      expect(result[mode].memories.map((m: { id: string }) => m.id)).toEqual(["shared", "recent"]);
      expect(result[mode].memories[0].similarity).toBeUndefined();
      expect(result[mode].context).toContain(
        '<memory selection="recent" id="shared" created="2026-10-31" project="project">\nshared body'
      );
      expect(result[mode].context).not.toContain("retrieval_score=");
      expect(result[mode].context).not.toContain("relevance=");
      expect(result[mode].context).not.toContain("ranking signals");
    });
  }
  it("preserves genuine scores without turning them into confidence percentages", () => {
    expect(result.relevant.memories[0].similarity).toBe(0.742);
    expect(result.relevant.context).toContain('selection="semantic" retrieval_score="0.742"');
    expect(result.relevant.context).not.toContain("74%");
  });
  it("preserves deduplication, order and distinct metadata in mixed recall", () => {
    expect(result.both.memories.map((m: { id: string }) => m.id)).toEqual(["shared", "recent"]);
    expect(result.both.context).toContain('selection="semantic" retrieval_score="0.742"');
    expect(result.both.context).toContain('<memory selection="recent" id="recent"');
  });
  it("retains the existing boost and explains its ranking-only meaning", () => {
    expect(result.boosted.memories[0].similarity).toBeCloseTo(0.792);
    expect(result.boosted.context).toContain('retrieval_score="0.792"');
    expect(result.boosted.context).toContain(
      "ranking signals that may include a project boost, not confidence in factual accuracy"
    );
    expect(result.searchCalls).toBe(3);
  });
});
