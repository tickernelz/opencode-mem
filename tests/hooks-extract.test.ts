import { describe, expect, it } from "bun:test";
import { isStructuredSummaryPromptMessage } from "../src/hooks/chat-message.js";
import { formatSearchResults } from "../src/hooks/memory-tool.js";
import { formatMemoriesForCompaction } from "../src/hooks/session-events.js";

describe("extracted hook helpers", () => {
  it("detects structured summary prompts", () => {
    expect(
      isStructuredSummaryPromptMessage(
        'Analyze this conversation.\n<template type="skip"></template>'
      )
    ).toBe(true);
    expect(isStructuredSummaryPromptMessage("Analyze this conversation in the bug report.")).toBe(
      false
    );
  });

  it("formats search results for the memory tool", () => {
    const json = JSON.parse(
      formatSearchResults(
        "auth",
        {
          results: [{ id: "m1", memory: "Use OAuth", similarity: 0.91 }],
        },
        5
      )
    );
    expect(json.success).toBe(true);
    expect(json.query).toBe("auth");
    expect(json.results[0].similarity).toBe(91);
  });

  it("formats compaction memory context", () => {
    const text = formatMemoriesForCompaction([
      { memory: "Prefer bun over npm", tags: ["tooling"] },
    ]);
    expect(text).toContain("Restored Session Memory");
    expect(text).toContain("Prefer bun over npm");
    expect(text).toContain("tooling");
  });
});
