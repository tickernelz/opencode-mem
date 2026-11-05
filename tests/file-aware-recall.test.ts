import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const child = Bun.spawnSync([
  process.execPath,
  fileURLToPath(new URL("./fixtures/file-aware-recall.mjs", import.meta.url)),
]);
if (child.exitCode !== 0) throw new Error(child.stderr.toString());
const result = JSON.parse(child.stdout.toString());
const ids = (name: string) => result[name].memories.map((memory: { id: string }) => memory.id);

describe("file-aware recall selection", () => {
  it("supplements an empty vague-prompt search and leaves unrelated files empty", () => {
    expect(ids("vagueBaseline")).toEqual([]);
    expect(result.vagueBaseline.fileCalls).toEqual([]);
    expect(ids("vagueWithFile")).toEqual(["known-gotcha"]);
    expect(ids("unrelatedFile")).toEqual([]);
  });

  it("deduplicates against semantic recall within the original count", () => {
    expect(ids("deduplicated")).toEqual(["semantic-a", "known-gotcha", "semantic-c"]);
    expect(ids("oneSlot")).toEqual(["known-gotcha"]);
    expect(ids("disabledCount")).toEqual([]);
    expect(result.disabledCount.fileCalls).toEqual([]);
  });

  it("labels the association honestly with provenance and no confidence score", () => {
    const context = result.vagueWithFile.context;
    expect(context).toContain('selection="file" id="known-gotcha" created="2026-11-01"');
    expect(context).toContain("does not establish relevance or freshness");
    expect(context).toContain("Verify against current source code");
    expect(context).not.toContain("retrieval_score=");
  });

  it("preserves normal recall when file lookup fails, and semantic fallback when needed", () => {
    expect(ids("fileFailure")).toEqual(["semantic-a", "known-gotcha", "semantic-c"]);
    expect(ids("fileThrows")).toEqual(ids("fileFailure"));
    expect(ids("semanticFailure")).toEqual(["known-gotcha", "recent"]);
  });

  it("uses only the current project and forwards age/session exclusions", () => {
    expect(result.vagueWithFile.fileCalls).toEqual([
      [
        "project",
        { version: 1, workspace: "a".repeat(64), paths: ["src/retry.ts"] },
        4,
        { excludeSessionId: "current", createdAfter: Date.UTC(2026, 9, 6) },
      ],
    ]);
    expect(result.disabledFilters.fileCalls[0][3]).toEqual({});
  });
});
