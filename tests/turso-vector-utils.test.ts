import { describe, expect, it } from "bun:test";
import {
  distanceToSimilarity,
  escapeLikePattern,
  formatTagsForEmbedding,
  parseSessionIdFromMetadata,
  tokenizeQueryText,
} from "../src/storage/turso/vector-utils.js";

describe("turso vector utils", () => {
  it("clamps cosine distance float artifacts into [0, 1] similarity", () => {
    expect(distanceToSimilarity(0)).toBe(1);
    expect(distanceToSimilarity(1)).toBe(0);
    expect(distanceToSimilarity(-1e-14)).toBe(1);
    expect(distanceToSimilarity(2)).toBe(0);
    expect(distanceToSimilarity(Number.NaN)).toBe(0);
  });

  it("formats tag embedding text consistently", () => {
    expect(formatTagsForEmbedding(["auth", "jwt"])).toBe("Topics: auth, jwt");
  });

  it("tokenizes query text and escapes LIKE wildcards", () => {
    expect(tokenizeQueryText("Hello, world_test")).toEqual(["hello", "world", "test"]);
    expect(escapeLikePattern("100%_done")).toBe("100\\%\\_done");
    expect(parseSessionIdFromMetadata(JSON.stringify({ sessionID: "s1" }))).toBe("s1");
    expect(parseSessionIdFromMetadata("{bad")).toBeNull();
  });
});
