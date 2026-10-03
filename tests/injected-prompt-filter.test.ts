import { describe, expect, it } from "bun:test";
import {
  containsInjectionMarker,
  filterInjectedParts,
  getDefaultInjectionMarkers,
  isInjectedPart,
} from "../src/memory/injected-prompt-filter.js";
import { normalizeInjectionMarkers } from "../src/config.js";

// Verbatim samples taken from a real OpenCode session store, where 490 of 801
// recorded user messages consisted entirely of injected content.
const BACKGROUND_TASK_NOTIFICATION = [
  "<system-reminder>",
  "[BACKGROUND TASK RESULT READY]",
  "**ID:** `bg_5f29c4a2`",
  "**Description:** Explore codebase patterns",
  "**Duration:** 2m 41s",
  "",
  "**1 task still in progress.** You WILL be notified when ALL complete.",
  "Do NOT poll - continue productive work.",
  "</system-reminder>",
].join("\n");

const INTERNAL_CONTINUATION = [
  "[restore checkpointed session agent configuration after compaction]",
  "<!-- OMO_INTERNAL_INITIATOR -->",
  "<!-- OMO_INTERNAL_NOREPLY -->",
].join("\n");

const REAL_USER_PROMPT = "Refactor the auth middleware so token refresh happens before validation.";

describe("containsInjectionMarker", () => {
  it("detects host reminder wrappers", () => {
    expect(containsInjectionMarker(BACKGROUND_TASK_NOTIFICATION)).toBe(true);
  });

  it("detects plugin internal-message markers", () => {
    expect(containsInjectionMarker(INTERNAL_CONTINUATION)).toBe(true);
  });

  it("leaves genuine user text untouched", () => {
    expect(containsInjectionMarker(REAL_USER_PROMPT)).toBe(false);
  });

  it("ignores empty input", () => {
    expect(containsInjectionMarker("")).toBe(false);
  });

  it("matches regardless of marker casing", () => {
    expect(containsInjectionMarker("<System-Reminder>\nstatus\n</System-Reminder>")).toBe(true);
  });

  it("honors a caller-supplied marker list", () => {
    expect(containsInjectionMarker("<my-banner>hi", ["<my-banner>"])).toBe(true);
    expect(containsInjectionMarker(BACKGROUND_TASK_NOTIFICATION, ["<my-banner>"])).toBe(false);
  });

  it("does not flag text that merely mentions a marker name in prose", () => {
    expect(containsInjectionMarker("why does the system reminder keep firing?")).toBe(false);
  });
});

describe("isInjectedPart", () => {
  it("treats host-flagged synthetic parts as injected", () => {
    expect(isInjectedPart({ type: "text", text: "anything", synthetic: true })).toBe(true);
  });

  it("detects injected parts that carry no synthetic flag", () => {
    // Regression guard: the observed injections set no synthetic flag at all,
    // so structural detection alone would miss the overwhelming majority.
    expect(isInjectedPart({ type: "text", text: INTERNAL_CONTINUATION })).toBe(true);
    expect(isInjectedPart({ type: "text", text: BACKGROUND_TASK_NOTIFICATION })).toBe(true);
  });

  it("keeps authored parts", () => {
    expect(isInjectedPart({ type: "text", text: REAL_USER_PROMPT })).toBe(false);
  });

  it("treats a part with no text as authored when not flagged", () => {
    expect(isInjectedPart({ type: "text" })).toBe(false);
  });
});

describe("filterInjectedParts", () => {
  it("returns nothing when every part is injected", () => {
    const parts = [
      { type: "text", text: BACKGROUND_TASK_NOTIFICATION },
      { type: "text", text: INTERNAL_CONTINUATION },
    ];
    expect(filterInjectedParts(parts)).toEqual([]);
  });

  it("strips the injected block from a mixed message", () => {
    const parts = [
      { type: "text", text: BACKGROUND_TASK_NOTIFICATION },
      { type: "text", text: REAL_USER_PROMPT },
    ];
    expect(filterInjectedParts(parts)).toEqual([{ type: "text", text: REAL_USER_PROMPT }]);
  });

  it("preserves an entirely authored message", () => {
    const parts = [{ type: "text", text: REAL_USER_PROMPT }];
    expect(filterInjectedParts(parts)).toEqual(parts);
  });

  it("preserves part order", () => {
    const parts = [
      { type: "text", text: "first" },
      { type: "text", text: BACKGROUND_TASK_NOTIFICATION },
      { type: "text", text: "second" },
    ];
    expect(filterInjectedParts(parts).map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("handles an empty parts array", () => {
    expect(filterInjectedParts([])).toEqual([]);
  });
});

describe("normalizeInjectionMarkers", () => {
  it("returns the built-in markers when unset", () => {
    expect(normalizeInjectionMarkers(undefined)).toEqual([...getDefaultInjectionMarkers()]);
  });

  it("appends custom markers instead of replacing the defaults", () => {
    const result = normalizeInjectionMarkers(["<my-banner>"]);
    for (const builtin of getDefaultInjectionMarkers()) {
      expect(result).toContain(builtin);
    }
    expect(result).toContain("<my-banner>");
  });

  it("ignores blank entries and case-insensitive duplicates", () => {
    const result = normalizeInjectionMarkers(["", "   ", "<SYSTEM-REMINDER>"]);
    expect(result).toEqual([...getDefaultInjectionMarkers()]);
  });

  it("trims surrounding whitespace on custom markers", () => {
    expect(normalizeInjectionMarkers(["  <my-banner>  "])).toContain("<my-banner>");
  });

  it("rejects a non-array value", () => {
    expect(() => normalizeInjectionMarkers("<my-banner>" as unknown as string[])).toThrow(
      /expected an array/
    );
  });

  it("rejects non-string entries", () => {
    expect(() => normalizeInjectionMarkers([42 as unknown as string])).toThrow(/expected a string/);
  });

  it("does not mutate the built-in marker list across calls", () => {
    normalizeInjectionMarkers(["<my-banner>"]);
    expect(normalizeInjectionMarkers(undefined)).not.toContain("<my-banner>");
  });
});
