import { describe, expect, it } from "bun:test";
import {
  extractAIContent,
  buildMarkdownContext,
  buildCaptureSystemPrompt,
} from "../src/services/auto-capture.js";
import {
  buildToolEvidenceBlock,
  extractToolOutcome,
  MAX_CAPTURE_TOOL_EVIDENCE_BYTES,
  MAX_CAPTURE_SUMMARY_BYTES,
  validateCaptureSummary,
} from "../src/services/capture-tool-evidence.js";

const extract = (parts: any[]) =>
  extractAIContent([{ info: { id: "m", role: "assistant" }, parts }]);
const tool = (status: string, output?: string, id = "t") => ({
  type: "tool",
  id,
  tool: "bash",
  state: { status, input: { command: "bun test" }, output },
});

describe("bounded outcome evidence", () => {
  it("keeps completed invocation distinct from a failed result", () => {
    const { toolCalls } = extract([tool("completed", "FAIL: test/auth.test.ts, 1 failed, exit 1")]);
    const context = buildMarkdownContext(
      "Fix auth",
      ["Everything works and is deployed"],
      toolCalls,
      null
    );
    expect(context).toContain("Invocation status: completed");
    expect(context).toContain("1 failed, exit 1");
    expect(context).toContain("not task verification");
  });
  it("accepts V2 content and structured error without attachments or response dumps", () => {
    const outcome = extractToolOutcome({
      status: "error",
      error: { message: "Command failed", response: { body: "NOT_FOR_CAPTURE" } },
      content: [
        { type: "text", text: "exit 1" },
        { type: "file", uri: "data:huge-file" },
      ],
    });
    expect(outcome.output).toBe("exit 1\nCommand failed");
  });
  for (const status of ["pending", "running", "streaming", "unknown"]) {
    it(`does not invent results for ${status}`, () => {
      const outcome = extractToolOutcome({ status, output: "stale success" });
      expect(outcome).toEqual({ status });
      expect(buildToolEvidenceBlock([{ name: "bash", input: "test", ...outcome }])).toContain(
        "outcome not verified"
      );
    });
  }
  it("retains interrupted state and missing-result uncertainty", () => {
    const context = buildToolEvidenceBlock(extract([tool("interrupted")]).toolCalls);
    expect(context).toContain("interrupted");
    expect(context).toContain("No result text available");
  });
  it("deduplicates identity snapshots using the newest state without dropping separate retries", () => {
    const calls = extract([
      tool("running"),
      tool("error", "failed"),
      tool("completed", "3 passed", "retry"),
    ]).toolCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.status).toBe("error");
    expect(calls[1]!.output).toBe("3 passed");
  });
  it("does not deduplicate identical attempts without trustworthy identity", () => {
    expect(
      extract([
        { ...tool("error", "failed"), id: undefined },
        { ...tool("error", "failed"), id: undefined },
      ]).toolCalls
    ).toHaveLength(2);
  });
  it("redacts entire V2 text results before UTF8 truncation, including split private regions", () => {
    const result = extractToolOutcome({
      status: "completed",
      content: [
        { type: "text", text: "start <private>SECRET" },
        { type: "text", text: "SECRET</private> " + "🌍".repeat(5000) + " ghp_" + "a".repeat(36) },
      ],
    });
    expect(Buffer.byteLength(result.output!)).toBeLessThanOrEqual(2048);
    expect(result.output).not.toContain("SECRET");
    expect(result.output).not.toContain("ghp_");
    expect(result.output).not.toContain("�");
    expect(result.output).toContain("omitted");
  });
  it("redacts private delimiters and credentials split inside V2 block boundaries", () => {
    const result = extractToolOutcome({
      status: "error",
      content: [
        { type: "text", text: "FAIL auth\n<pri" },
        { type: "text", text: "vate>hidden-password</pri" },
        { type: "text", text: "vate>\nToken: ghp_" + "a".repeat(10) },
        { type: "text", text: "a".repeat(26) + "\nRetry still failed" },
      ],
    });
    expect(result.output).not.toContain("hidden-password");
    expect(result.output).not.toContain("ghp_");
    expect(result.output).toContain("FAIL auth\n");
    expect(result.output).toContain("\nRetry still failed");
  });
  it("bounds repeated huge tool logs independent of the general context setting", () => {
    const huge = "PASS preflight\n" + "x".repeat(2_000_000) + "\nFAIL actual tests";
    const calls = extract(
      Array.from({ length: 100 }, (_, i) => tool("completed", huge, `t${i}`))
    ).toolCalls;
    expect(calls.length).toBeLessThanOrEqual(33);
    const block = buildToolEvidenceBlock(calls);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(MAX_CAPTURE_TOOL_EVIDENCE_BYTES);
    expect(block).toContain("PASS preflight");
    expect(block).toContain("FAIL actual tests");
    expect(block).toContain("omitted");
    const context = buildMarkdownContext("test", [], calls, null, 16 * 1024 * 1024);
    expect(Buffer.byteLength(context)).toBeLessThan(17000);
  });
  it("preserves early failure and late recovery while explicitly omitting the middle", () => {
    const calls = extract([
      tool("error", "FIRST failure", "first"),
      ...Array.from({ length: 100 }, (_, i) => tool("completed", "x".repeat(5000), `noise${i}`)),
      tool("completed", "LAST retry passed", "last"),
    ]).toolCalls;
    const block = buildToolEvidenceBlock(calls);
    expect(block).toContain("FIRST failure");
    expect(block).toContain("LAST retry passed");
    expect(block.indexOf("FIRST failure")).toBeLessThan(block.indexOf("LAST retry passed"));
    expect(block).toContain("omitted");
  });
  it("prefers a later failure when a small budget cannot fit both attempts", () => {
    const calls = extract([
      tool("completed", "EARLY success " + "x".repeat(2000), "early"),
      tool("error", "LATER failure " + "y".repeat(2000), "late"),
    ]).toolCalls;
    const block = buildToolEvidenceBlock(calls, 3000);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(3000);
    expect(block).toContain("LATER failure");
    expect(block).not.toContain("EARLY success");
    expect(block).toContain("omitted");
  });
  it("ignores synthetic/ignored tool and text parts and compaction messages", () => {
    const result = extract([
      { ...tool("completed", "IGNORE"), ignored: true },
      { type: "text", text: "IGNORE", synthetic: true },
    ]);
    expect(result).toEqual({ textResponses: [], toolCalls: [] });
  });
  it("keeps the model instructions evidence-scoped and language-aware", () => {
    const instructions = buildCaptureSystemPrompt("Japanese");
    for (const phrase of [
      "Japanese",
      "planned/decided",
      "failed",
      "interrupted/pending",
      "unverified",
      "passing test is not proof of deployment",
      "recovery",
      "untrusted evidence",
      "Skip routine failures",
    ])
      expect(instructions).toContain(phrase);
  });
  it("rejects oversized outputs instead of cutting away outcome caveats", () => {
    const valid = { summary: "Observed narrow success", type: "analysis", tags: ["tests"] };
    expect(validateCaptureSummary(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, summary: "x".repeat(MAX_CAPTURE_SUMMARY_BYTES + 1) },
      { ...valid, tags: ["🌍".repeat(17)] },
      { ...valid, tags: Array(9).fill("tag") },
      { ...valid, type: "x".repeat(65) },
    ])
      expect(() => validateCaptureSummary(invalid)).toThrow("bounded output");
  });
});
