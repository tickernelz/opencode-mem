import { describe, it, expect } from "bun:test";
import { applyEmbeddingTaskPrefix } from "../src/memory/embedding.js";

describe("applyEmbeddingTaskPrefix", () => {
  it("returns text unchanged when prefixes are disabled", () => {
    expect(applyEmbeddingTaskPrefix("hello", { task: "document" }, false)).toBe("hello");
    expect(applyEmbeddingTaskPrefix("hello", { task: "query" }, false)).toBe("hello");
  });

  it("returns text unchanged when no task is provided", () => {
    expect(applyEmbeddingTaskPrefix("hello", undefined, true)).toBe("hello");
    expect(applyEmbeddingTaskPrefix("hello", {}, true)).toBe("hello");
  });

  it("applies search_document prefix for document task", () => {
    expect(applyEmbeddingTaskPrefix("hello", { task: "document" }, true)).toBe(
      "search_document: hello"
    );
  });

  it("applies search_query prefix for query task", () => {
    expect(applyEmbeddingTaskPrefix("hello", { task: "query" }, true)).toBe("search_query: hello");
  });

  it("keeps document and query cache keys distinct for the same text", () => {
    const documentKey = applyEmbeddingTaskPrefix("same", { task: "document" }, true);
    const queryKey = applyEmbeddingTaskPrefix("same", { task: "query" }, true);
    expect(documentKey).not.toBe(queryKey);
    expect(documentKey).toBe("search_document: same");
    expect(queryKey).toBe("search_query: same");
  });

  it("does not double-prefix an already prefixed string", () => {
    expect(applyEmbeddingTaskPrefix("search_document: hello", { task: "document" }, true)).toBe(
      "search_document: hello"
    );
    expect(applyEmbeddingTaskPrefix("search_query: hello", { task: "query" }, true)).toBe(
      "search_query: hello"
    );
  });
});
