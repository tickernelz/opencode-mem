import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "file-memory-plugin-"));
let output: any;
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeAll(() => {
  const child = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("./fixtures/file-memory-plugin.mjs", import.meta.url)),
    directory,
  ]);
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  output = JSON.parse(child.stdout.toString().trim());
});

describe("shared plugin file recall bridge", () => {
  it("uses the supplemental slot for a novel match after a semantic duplicate", () => {
    expect(output.result.overlapThenNovel.text).toContain('selection="file" id="file-gotcha"');
    expect(output.result.overlapThenNovel.text).toContain(
      'selection="semantic" retrieval_score="0.8" id="semantic-first"'
    );
    expect(output.result.overlapThenNovel.text).not.toContain('id="semantic-second"');
    expect(output.result.overlapOnly.text).toBe(output.baseContext);
    expect(output.result.overlapOnly.profile).toEqual([]);
  });
  it("binds a file refresh to active A while ordinary recall still uses newest queued B", () => {
    const { active, ordinary } = output.result;
    expect(active.pending).toEqual([["regular", "active-a", output.directory]]);
    expect(active.search.map((call: any[]) => call[0])).toEqual(["Active request A"]);
    expect(active.file).toHaveLength(1);
    expect(active.file[0][0]).toBe(output.projectTag);
    expect(active.file[0][1].paths).toEqual(["src/auth.ts"]);
    expect(active.file[0][1].workspace).toMatch(/^[a-f0-9]{64}$/);
    expect(active.file[0][2]).toBe(3);
    expect(active.file[0][3].excludeSessionId).toBe("regular");
    expect(active.text).toContain('selection="file" id="file-gotcha"');
    expect(active.text).toContain("Recall for: Active request A");
    expect(active.text).not.toContain("Queued request B");
    expect(active.text.match(/<memory /g) ?? []).toHaveLength(2);
    expect(active.profile).toHaveLength(1);
    expect(ordinary.pending).toEqual([]);
    expect(ordinary.search.map((call: any[]) => call[0])).toEqual(["Queued request B"]);
    expect(ordinary.file).toEqual([]);
    expect(ordinary.text.match(/<memory /g) ?? []).toHaveLength(2);
    expect(ordinary.profile).toHaveLength(1);
  });
  it("does not associate files with private, absent or differently scoped prompts", () => {
    for (const name of ["private", "missing", "wrongDirectory", "wrongSession"]) {
      const result = output.result[name];
      expect(result.file).toEqual([]);
      expect(result.text).not.toContain('selection="file"');
      expect(result.text).not.toContain("private-request");
      expect(result.text).toBe(output.baseContext);
      expect(result.search).toEqual([]);
      expect(result.list).toEqual([]);
      expect(result.profile).toEqual([]);
    }
  });
  it("keeps ordinary recall when file awareness is off, storage is Markdown or a path escapes", () => {
    for (const name of ["flagDisabled", "markdown", "workspace", "outside"]) {
      expect(output.result[name].file).toEqual([]);
      expect(output.result[name].search).toEqual([]);
      expect(output.result[name].list).toEqual([]);
      expect(output.result[name].profile).toEqual([]);
      expect(output.result[name].text).toBe(output.baseContext);
    }
  });
  it("suppresses internal, child, disabled and unconfigured sessions before lookups", () => {
    for (const name of ["internal", "child", "injectionDisabled", "unconfigured"]) {
      expect(output.result[name]).toEqual({
        text: "",
        search: [],
        file: [],
        list: [],
        pending: [],
        profile: [],
      });
    }
  });
  it("honors the original zero-memory count", () => {
    expect(output.result.zeroCount.text).toBe(output.baseContext);
    expect(output.result.zeroCount.file).toEqual([]);
    expect(output.result.zeroCount.search).toEqual([]);
    expect(output.result.zeroCount.list).toEqual([]);
    expect(output.result.zeroCount.profile).toEqual([]);
  });
  it("keeps cached bytes and avoids ordinary recall or profile rebuilding on no-match and file-query errors", () => {
    for (const name of [
      "noFileMatch",
      "recentNoFileMatch",
      "fileFailure",
      "fileThrows",
      "emptyPaths",
    ]) {
      expect(output.result[name].text).toBe(output.baseContext);
      expect(output.result[name].search).toEqual([]);
      expect(output.result[name].list).toEqual([]);
      expect(output.result[name].profile).toEqual([]);
      expect(output.result[name].file).toHaveLength(name === "emptyPaths" ? 0 : 1);
    }
  });
});
