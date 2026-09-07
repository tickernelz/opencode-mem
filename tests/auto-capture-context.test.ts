import { describe, expect, it } from "bun:test";
import {
  buildBoundedSummaryPrompt,
  buildMarkdownContext,
  getAutoCaptureMarkdownBudget,
} from "../src/services/auto-capture.js";
import { utf8ByteLength } from "../src/utils/context-limit.js";

describe("buildMarkdownContext budgeting (#232)", () => {
  it("leaves small contexts unchanged", () => {
    const context = buildMarkdownContext(
      "Fix the bug",
      ["Done. Updated the handler."],
      [{ name: "edit", input: "file.ts" }],
      "Prior memory",
      131072
    );

    expect(context).toContain("## User Request");
    expect(context).toContain("Fix the bug");
    expect(context).toContain("Done. Updated the handler.");
    expect(context).toContain("## Tools Used");
    expect(context).not.toContain("truncated to autoCaptureMaxContextBytes");
  });

  it("truncates oversized AI responses within the total budget", () => {
    const hugeAi = "A".repeat(50_000);
    const maxBytes = 8_192;
    const context = buildMarkdownContext("short request", [hugeAi], [], null, maxBytes);

    expect(utf8ByteLength(context)).toBeLessThanOrEqual(maxBytes);
    expect(context).toContain("short request");
    expect(context).toContain("truncated to autoCaptureMaxContextBytes");
  });

  it("prefers newer AI responses when multiple turns exceed the budget", () => {
    const older = "OLD-" + "x".repeat(4_000);
    const newer = "NEW-" + "y".repeat(4_000);
    const maxBytes = 3_000;
    const context = buildMarkdownContext("q", [older, newer], [], null, maxBytes);

    expect(utf8ByteLength(context)).toBeLessThanOrEqual(maxBytes);
    expect(context).toContain("NEW-");
    // Older content may be dropped entirely once the newest turn fills the budget.
    expect(context.includes("OLD-") && !context.includes("NEW-")).toBe(false);
  });

  it("preserves section order: memory, user, AI, tools", () => {
    const context = buildMarkdownContext(
      "request",
      ["response"],
      [{ name: "bash", input: "ls" }],
      "memory",
      131072
    );

    const memoryIdx = context.indexOf("## Previous Memory Context");
    const userIdx = context.indexOf("## User Request");
    const aiIdx = context.indexOf("## AI Response");
    const toolsIdx = context.indexOf("## Tools Used");

    expect(memoryIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(memoryIdx);
    expect(aiIdx).toBeGreaterThan(userIdx);
    expect(toolsIdx).toBeGreaterThan(aiIdx);
  });

  it("guarantees the total UTF-8 size never exceeds the configured limit", () => {
    const context = buildMarkdownContext(
      "U".repeat(20_000),
      ["A".repeat(40_000), "B".repeat(40_000)],
      [{ name: "read", input: "x".repeat(100) }],
      "M".repeat(500),
      10_000
    );

    expect(utf8ByteLength(context)).toBeLessThanOrEqual(10_000);
  });

  it("reserves request space for prompts, schemas, and model output", () => {
    const totalBudget = 131_072;
    const markdownBudget = getAutoCaptureMarkdownBudget(totalBudget);
    const context = buildMarkdownContext(
      "request",
      ["A".repeat(totalBudget)],
      [],
      null,
      markdownBudget
    );
    const systemPrompt = "system instructions";
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const userPrompt = buildBoundedSummaryPrompt(context, systemPrompt, schema, totalBudget);

    expect(markdownBudget).toBeLessThan(totalBudget);
    expect(utf8ByteLength(userPrompt)).toBeLessThan(totalBudget);
    expect(userPrompt).toContain("truncated to autoCaptureMaxContextBytes");
  });
});
