import { describe, expect, it } from "bun:test";
import { mergeFileRecall, type RecallMemory } from "../src/services/memory-recall.js";

const memory = (id: string, selection: "file" | "semantic" = "semantic"): RecallMemory => ({
  id,
  memory: id,
  selection,
});
describe("file recall supplies additional information", () => {
  const ordinary = [memory("retry"), memory("labels"), memory("page")];
  it("does not let a later already-semantic label replace the missing TTL lesson", () => {
    expect(
      mergeFileRecall([memory("labels", "file"), memory("ttl", "file")], ordinary, 3).map(
        (m) => m.id
      )
    ).toEqual(["ttl", "retry", "labels"]);
  });
  it("preserves ordinary order, provenance and identity when all matches overlap", () => {
    expect(mergeFileRecall([memory("labels", "file")], ordinary, 3)).toBe(ordinary);
  });
  it("keeps a single file supplement within the count limit", () => {
    expect(
      mergeFileRecall([memory("ttl", "file"), memory("other", "file")], ordinary, 1).map(
        (m) => m.id
      )
    ).toEqual(["ttl"]);
    expect(mergeFileRecall([memory("ttl", "file")], [], 0)).toEqual([]);
  });
});
