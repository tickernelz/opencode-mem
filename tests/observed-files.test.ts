import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  collectObservedFiles,
  createObservedFileContext,
  extractCompletedFilePath,
  isObservedFiles,
  MAX_OBSERVED_FILES,
  type ObservedFileContext,
} from "../src/services/observed-files.js";

let directory: string;
let root: string;
let context: ObservedFileContext;

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "opencode-mem-observed-files-")));
  root = join(directory, "checkout");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "tests"));
  await mkdir(join(root, "..special"));
  for (const path of ["src/main.ts", "tests/main.ts", "src/has space.ts", "..special/file.ts"])
    await writeFile(join(root, path), "synthetic fixture");
  context = (await createObservedFileContext(root))!;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function completed(tool: string, path: unknown, output: unknown = { type: "text-page" }) {
  return { tool, input: { path }, status: "completed", result: { output } };
}

function snapshot(path: unknown, overrides: Record<string, unknown> = {}) {
  return {
    type: "tool",
    name: "read",
    id: "read-1",
    state: { status: "completed", input: { path }, content: [{ type: "text", text: "ignored" }] },
    ...overrides,
  };
}

function assistant(parts: unknown[], overrides: Record<string, unknown> = {}) {
  return { info: { role: "assistant", id: "assistant-1", ...overrides }, parts };
}

describe("native completed file candidates", () => {
  it("accepts the verified V2 native contract without filesystem work", () => {
    expect(extractCompletedFilePath(completed("read", "src/main.ts"))).toBe("src/main.ts");
    expect(extractCompletedFilePath(completed("read", "image.png", { type: "file" }))).toBe(
      "image.png"
    );
    expect(extractCompletedFilePath(completed("edit", "src/main.ts"))).toBe("src/main.ts");
    expect(extractCompletedFilePath(completed("write", "not-created-yet.ts"))).toBe(
      "not-created-yet.ts"
    );
  });

  it("rejects directories, unsuccessful calls, other tools and guessed argument fields", () => {
    for (const event of [
      completed("read", "src", { type: "list-page" }),
      completed("read", "src/main.ts", {}),
      { ...completed("read", "src/main.ts"), result: undefined },
      { ...completed("read", "src/main.ts"), status: "error" },
      { ...completed("read", "src/main.ts"), status: "running" },
      completed("bash", "src/main.ts"),
      completed("apply_patch", "src/main.ts"),
      completed("mcp_read", "src/main.ts"),
      { ...completed("read", "src/main.ts"), input: { filePath: "src/main.ts" } },
      { ...completed("read", "src/main.ts"), input: '{"path":"src/main.ts"}' },
      null,
    ]) {
      expect(extractCompletedFilePath(event)).toBeUndefined();
    }
  });

  it("rejects unsafe, private, malformed and overlong paths before retaining candidates", () => {
    const secret = "ghp_" + "a".repeat(36);
    for (const path of [
      "../outside.ts",
      "src/../main.ts",
      "https://example.test/file.ts",
      "file:///tmp/file.ts",
      ...(sep === "/"
        ? ["C:\\repo\\file.ts", "C:/repo/file.ts", "\\\\host\\share\\file.ts", "src\\main.ts"]
        : []),
      "src/\nfile.ts",
      "src/\0file.ts",
      "src/<private>secret</private>.ts",
      "src/[REDACTED].ts",
      `src/${secret}.ts`,
      "a".repeat(513),
      "é".repeat(257),
      "",
      123,
      ["src/main.ts"],
    ]) {
      expect(extractCompletedFilePath(completed("write", path))).toBeUndefined();
    }
  });
});

describe("observed-file workspace and path identity", () => {
  it("normalizes exact files relative to the actual checkout and deduplicates spellings", async () => {
    const observed = await context.normalizeCandidates([
      "./src/main.ts",
      join(root, "src/main.ts"),
      "src/has space.ts",
      "tests/main.ts",
      "..special/file.ts",
    ]);
    expect(observed).toEqual({
      version: 1,
      workspace: context.workspace,
      paths: ["src/main.ts", "src/has space.ts", "tests/main.ts", "..special/file.ts"],
    });
    expect(isObservedFiles(observed)).toBe(true);
    expect(JSON.stringify(observed)).not.toContain(root);
  });

  it("retains native absolute paths independently of relative-path candidates", async () => {
    const absolute = join(root, "src/main.ts");
    expect(extractCompletedFilePath(completed("read", absolute))).toBe(absolute);
    expect((await context.normalizeCandidates([absolute]))?.paths).toEqual(["src/main.ts"]);
  });

  it("does not mistake native home shorthand for a literal project tilde directory", async () => {
    await mkdir(join(root, "~"));
    await writeFile(join(root, "~/file.ts"), "unrelated literal tilde directory");
    for (const path of ["~", "~/file.ts", "~\\file.ts"]) {
      expect(extractCompletedFilePath(completed("read", path))).toBeUndefined();
      expect(await context.normalizeCandidates([path])).toBeUndefined();
      expect(await collectObservedFiles([assistant([snapshot(path)])], context)).toBeUndefined();
    }
    // The host does not expand a tilde when it is not the leading component.
    expect((await context.normalizeCandidates(["./~/file.ts"]))?.paths).toEqual(["~/file.ts"]);
  });

  it("rejects Windows shell drive shorthand instead of guessing host expansion", async () => {
    for (const path of [
      "/c/file.ts",
      "/cygdrive/c/file.ts",
      "/mnt/c/file.ts",
      "/C:/file.ts",
      "/c",
      "/cygdrive/C",
      "/mnt/C",
      "/C:",
    ]) {
      expect(extractCompletedFilePath(completed("write", path))).toBeUndefined();
      expect(await context.normalizeCandidates([path])).toBeUndefined();
      expect(await collectObservedFiles([assistant([snapshot(path)])], context)).toBeUndefined();
    }
  });

  it("uses the same checkout identity from subdirectories and resolves relative args from cwd", async () => {
    const nested = (await createObservedFileContext(join(root, "src")))!;
    expect(nested.workspace).toBe(context.workspace);
    expect((await nested.normalizeCandidates(["main.ts"]))?.paths).toEqual(["src/main.ts"]);
    expect(await nested.normalizeCandidates(["../tests/main.ts"])).toBeUndefined();
  });

  it("keeps worktrees, independent projects and nested repositories separate", async () => {
    const worktree = join(directory, "branch");
    await mkdir(worktree);
    await writeFile(join(worktree, ".git"), `gitdir: ${join(root, ".git/worktrees/branch")}`);
    await writeFile(join(worktree, "main.ts"), "branch fixture");
    const branch = (await createObservedFileContext(worktree))!;
    expect(branch.workspace).not.toBe(context.workspace);
    expect(await context.normalizeCandidates([join(worktree, "main.ts")])).toBeUndefined();

    const nestedRoot = join(root, "nested-repo");
    await mkdir(join(nestedRoot, ".git"), { recursive: true });
    await writeFile(join(nestedRoot, ".git/HEAD"), "ref: refs/heads/main\n");
    const nested = (await createObservedFileContext(nestedRoot))!;
    expect(nested.workspace).not.toBe(context.workspace);
  });

  it("recognizes marker roots and uses the launch directory if no root exists", async () => {
    const marked = join(directory, "marked");
    await mkdir(join(marked, "nested"), { recursive: true });
    await writeFile(join(marked, ".opencode-mem-project"), "");
    const a = (await createObservedFileContext(marked))!;
    const b = (await createObservedFileContext(join(marked, "nested")))!;
    expect(a.workspace).toBe(b.workspace);
    const loose = join(directory, "loose");
    await mkdir(join(loose, "nested"), { recursive: true });
    expect((await createObservedFileContext(loose))?.workspace).not.toBe(
      (await createObservedFileContext(join(loose, "nested")))?.workspace
    );
  });

  it("rejects roots that are relative, missing or files", async () => {
    expect(await createObservedFileContext("src")).toBeNull();
    expect(await createObservedFileContext(join(directory, "missing"))).toBeNull();
    expect(await createObservedFileContext(join(root, "src/main.ts"))).toBeNull();
  });

  it("rejects missing/renamed paths, directories and wrong-case paths", async () => {
    await writeFile(join(root, "old.ts"), "fixture");
    await rename(join(root, "old.ts"), join(root, "new.ts"));
    const observed = await context.normalizeCandidates([
      "old.ts",
      "new.ts",
      "missing.ts",
      "src",
      ".",
      "src/Main.ts",
    ]);
    expect(observed?.paths).toEqual(["new.ts"]);
  });

  it("rejects symlink escapes, internal aliases and sibling root-prefix collisions", async () => {
    await writeFile(join(directory, "outside.ts"), "outside fixture");
    await symlink(join(directory, "outside.ts"), join(root, "escape.ts"));
    await symlink(join(root, "src/main.ts"), join(root, "alias.ts"));
    await symlink(join(root, "src"), join(root, "alias-dir"));
    const sibling = join(directory, "checkout-other");
    await mkdir(sibling);
    await writeFile(join(sibling, "main.ts"), "unrelated");
    expect(
      await context.normalizeCandidates([
        "escape.ts",
        "alias.ts",
        "alias-dir/main.ts",
        join(sibling, "main.ts"),
      ])
    ).toBeUndefined();
  });

  it("bounds normalized metadata and the amount of candidate work", async () => {
    const candidates: string[] = [];
    for (let i = 0; i < MAX_OBSERVED_FILES + 5; i++) {
      const path = `bulk-${i}.ts`;
      await writeFile(join(root, path), "fixture");
      candidates.push(path);
    }
    const observed = await context.normalizeCandidates(candidates);
    expect(observed?.paths).toHaveLength(MAX_OBSERVED_FILES);
    expect(
      await context.normalizeCandidates([...Array(64).fill("missing"), "src/main.ts"])
    ).toBeUndefined();
  });
});

describe("snapshot associations and persisted metadata", () => {
  it("collects only completed native V2 parts from assistant messages", async () => {
    const observed = await collectObservedFiles(
      [
        assistant([snapshot("tests/main.ts")], { role: "user" }),
        assistant([snapshot("tests/main.ts")], { summary: true }),
        assistant([
          snapshot("tests/main.ts", { id: "synthetic", synthetic: true }),
          snapshot("tests/main.ts", { id: "ignored", ignored: true }),
          snapshot("tests/main.ts", { id: "unknown", name: "bash" }),
          snapshot("tests/main.ts", {
            id: "failed",
            state: { status: "error", input: { path: "tests/main.ts" } },
          }),
          snapshot("tests/main.ts", {
            id: "running",
            state: { status: "running", input: { path: "tests/main.ts" } },
          }),
          snapshot("src/main.ts"),
        ]),
      ],
      context
    );
    expect(observed?.paths).toEqual(["src/main.ts"]);
  });

  it("uses the latest repeated snapshot and does not infer V1 fields or result prose", async () => {
    expect(
      await collectObservedFiles(
        [
          assistant([snapshot("src/main.ts")]),
          assistant([
            snapshot("src/main.ts", { state: { status: "error", input: { path: "src/main.ts" } } }),
          ]),
        ],
        context
      )
    ).toBeUndefined();
    expect(
      await collectObservedFiles(
        [
          assistant([
            {
              type: "tool",
              id: "v1",
              tool: "read",
              state: { status: "completed", input: { filePath: "src/main.ts" } },
            },
            snapshot(undefined, {
              id: "prose",
              state: { status: "completed", content: [{ type: "text", text: "read src/main.ts" }] },
            }),
          ]),
        ],
        context
      )
    ).toBeUndefined();
  });

  it("rejects directory reads and missing requested paths even without structured snapshot output", async () => {
    expect(
      await collectObservedFiles(
        [
          assistant([
            snapshot("src", { id: "directory" }),
            snapshot("src/main.t", { id: "fallback" }),
          ]),
        ],
        context
      )
    ).toBeUndefined();
  });

  it("bounds snapshot traversal and deduplicates repeated file calls", async () => {
    expect(
      (
        await collectObservedFiles(
          [
            assistant([
              snapshot("src/main.ts", { id: "read-a" }),
              snapshot("src/main.ts", { id: "read-b" }),
            ]),
          ],
          context
        )
      )?.paths
    ).toEqual(["src/main.ts"]);
    expect(
      await collectObservedFiles(
        [
          assistant([
            snapshot("src/main.ts"),
            ...Array(256).fill({ type: "text", text: "routine output" }),
          ]),
        ],
        context
      )
    ).toBeUndefined();
    expect(
      await collectObservedFiles(
        [assistant([snapshot("src/main.ts")]), ...Array(256).fill({ info: { role: "user" } })],
        context
      )
    ).toBeUndefined();
  });

  it("strictly validates metadata while permitting a separate summary digest", () => {
    const valid = { version: 1, workspace: "a".repeat(64), paths: ["src/main.ts"] };
    expect(isObservedFiles({ ...valid, contentHash: "b".repeat(64) })).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...valid, version: 2 },
      { ...valid, workspace: root },
      { ...valid, paths: [] },
      { ...valid, paths: Array(17).fill("src/main.ts") },
      { ...valid, paths: ["src/main.ts", "src/main.ts"] },
      ...[
        "/src/main.ts",
        "src/../main.ts",
        "./src/main.ts",
        "src//main.ts",
        "src\\main.ts",
        "src/[REDACTED].ts",
        "src/\nmain.ts",
      ].map((path) => ({ ...valid, paths: [path] })),
    ])
      expect(isObservedFiles(invalid)).toBe(false);
  });
});
