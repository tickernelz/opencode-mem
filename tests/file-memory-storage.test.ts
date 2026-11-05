import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindFilesToMemory, matchesFileMemory } from "../src/services/file-memory-association.js";
import { applyUpdateOnCaptureDecision } from "../src/services/update-on-capture.js";

const directory = mkdtempSync(join(tmpdir(), "file-memory-storage-"));
let result: any;
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeAll(() => {
  const child = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("./fixtures/file-memory-storage.mjs", import.meta.url)),
    directory,
  ]);
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  result = JSON.parse(child.stdout.toString().trim());
});

describe("file memory storage through native Turso", () => {
  it("requires an exact path, project, workspace and active valid captured association", () => {
    expect(result.eligible).toEqual(["valid-new", "valid-old"]);
    expect(result.wildcard).toEqual(["wildcard"]);
  });
  it("applies session and strict age eligibility before LIMIT across project shards", () => {
    expect(result.ageFiltered).toEqual(["valid-new"]);
    expect(result.includingCurrent).toEqual([
      "valid-new",
      "current-column",
      "current-metadata",
      "valid-old",
    ]);
    expect(result.one).toEqual(["valid-new"]);
    expect(result.afterManyExcluded).toEqual(["valid-new"]);
  });
  it("never calls embeddings or queries other scopes and bounds candidate reads", () => {
    expect(result.embeddingCalls).toBe(0);
    expect(
      result.shardRequests.every(
        ([scope, hash]: string[]) => scope === "project" && hash === "abcdef1234567890"
      )
    ).toBe(true);
    expect(Math.max(...result.readSizes)).toBeLessThanOrEqual(32);
    expect(result.staleWindow).toEqual(["valid-old"]);
  });
  it("fails closed for invalid requests and unsupported Markdown storage", () => {
    for (const key of ["zero", "invalidInput", "userScope", "markdown"])
      expect(result[key]).toEqual([]);
    expect(result.markdownRead).toBe(false);
  });
});

describe("file association content revisions", () => {
  const observed = { version: 1 as const, workspace: "a".repeat(64), paths: ["src/auth.ts"] };
  it("binds the sanitized persisted summary and invalidates rewritten content", () => {
    const observedFiles = bindFilesToMemory(
      observed,
      "public `src/auth.ts` <private>secret</private>"
    );
    expect(
      matchesFileMemory(
        { source: "auto-capture", observedFiles },
        "public `src/auth.ts` [REDACTED]",
        observed
      )
    ).toBe(true);
    expect(
      matchesFileMemory({ source: "auto-capture", observedFiles }, "different content", observed)
    ).toBe(false);
    expect(bindFilesToMemory(undefined, "content")).toBeNull();
  });
  it("rebinds a rewrite to its final content and clears associations absent new observations", async () => {
    const writes: any[] = [];
    const client = {
      addMemory: async () => ({ success: true, id: "new" }),
      updateMemory: async (_id: string, data: unknown) => {
        writes.push(data);
        return { success: true };
      },
      deleteMemory: async () => ({ success: true }),
      getMemoryById: async () => ({
        success: true,
        memory: { id: "old", content: "old", isPinned: false },
      }),
    };
    const input = {
      summary: "captured `src/auth.ts`",
      type: "bug-fix",
      tags: [],
      containerTag: "project",
      observedFiles: { ...observed, paths: ["src/auth.ts", "src/other.ts"] },
      metadata: {
        source: "auto-capture" as const,
        type: "bug-fix",
        tags: [],
        sessionID: "current",
        promptId: "prompt",
        captureTimestamp: 1,
        observedFiles: bindFilesToMemory(observed, "captured `src/auth.ts`"),
      },
    };
    await applyUpdateOnCaptureDecision(
      client,
      { action: "update", targetId: "old", content: "rewritten for `src/other.ts`" },
      input,
      new Set(["old"])
    );
    const rewritten = "rewritten for `src/other.ts`";
    expect(
      matchesFileMemory(writes[0].metadataPatch, rewritten, {
        ...observed,
        paths: ["src/other.ts"],
      })
    ).toBe(true);
    expect(matchesFileMemory(writes[0].metadataPatch, rewritten, observed)).toBe(false);
    const { observedFiles: _removed, ...withoutFiles } = input.metadata;
    await applyUpdateOnCaptureDecision(
      client,
      { action: "update", targetId: "old", content: "recovered" },
      { ...input, observedFiles: undefined, metadata: withoutFiles },
      new Set(["old"])
    );
    expect(writes[1].metadataPatch.observedFiles).toBeNull();
  });
});
