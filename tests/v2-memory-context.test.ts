import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "opencode-mem-v2-context-"));
let result: any;

afterAll(() => rmSync(directory, { recursive: true, force: true }));

beforeAll(() => {
  // Isolate module mocks from the suite. Drive the real shared plugin and
  // adapter with no database, provider calls, or actual host sessions.
  const child = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("./fixtures/v2-memory-context.mjs", import.meta.url)),
    directory,
  ]);
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  result = JSON.parse(child.stdout.toString().trim());
});

const context = (text: string) => ["<memory_context>" + text + "</memory_context>"];

describe("v2 memory context lifecycle", () => {
  it("retains first-turn context across later prompts and model steps", () => {
    expect(result.first).toEqual(context("original project knowledge"));
    expect(result.second).toEqual(result.first);
    expect(result.modelStep).toEqual(result.first);
    expect(result.firstLookups).toBe(1);
  });

  it("rebuilds cold context after reload without capturing a synthetic user prompt", () => {
    expect(result.resumed).toEqual(context("new project knowledge"));
    expect(result.afterResume).toEqual(result.resumed);
    expect(result.resumeCaptured).toBe(0);
    expect(result.alwaysResumed).toEqual(context("after empty lookup"));
    expect(result.alwaysResumeCaptured).toBe(0);
    expect(result.coldPrompt).toEqual(context("cold prompt knowledge"));
  });

  it("keeps session caches separate", () => {
    expect(result.otherSession).toEqual(context("other session knowledge"));
    expect(result.originalSessionAfterOther).toEqual(result.resumed);
  });

  it("applies current-session and age filters when restoring cold context", () => {
    expect(result.filteredResume).toEqual(context("eligible knowledge"));
  });

  it("refreshes one context block on each always-mode user turn", () => {
    expect(result.alwaysFirst).toEqual(context("other session knowledge"));
    expect(result.alwaysSecond).toEqual(context("refreshed project knowledge"));
  });

  it("removes stale context after empty or failed refreshes and allows recovery", () => {
    expect(result.empty).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.recovered).toEqual(context("after empty lookup"));
    expect(result.retried).toEqual(result.recovered);
  });

  it("honors disabled and unconfigured injection", () => {
    expect(result.disabled).toEqual([]);
    expect(result.unconfigured).toEqual([]);
  });

  it("suppresses internal, injected-only, and blank prompts without capturing them", () => {
    expect(result.internalPrompt).toEqual([]);
    expect(result.injectedOnly).toEqual([]);
    expect(result.blank).toEqual([]);
    expect(result.internalResume).toEqual([]);
    expect(result.realAfterInternal).toEqual(context("after empty lookup"));
    expect(result.captures).toHaveLength(11);
    expect(result.captures.every((capture: any) => capture.messageID.startsWith("msg-"))).toBe(
      true
    );
    expect(result.authored).toBe("authored first prompt");
  });

  it("preserves V1 synthetic-part injection and first-turn history policy", () => {
    expect(result.v1First).toHaveLength(2);
    expect(result.v1First[0].synthetic).toBe(true);
    expect(result.v1Later).toEqual([{ type: "text", text: "later v1 prompt" }]);
  });
});
