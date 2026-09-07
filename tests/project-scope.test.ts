import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { basename, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  findMarkerProjectRoot,
  getGitCommonDir,
  getGitTopLevel,
  getProjectTagInfo,
  getTags,
} from "../src/services/tags.js";

const createdDirs: string[] = [];

function run(command: string, cwd: string): void {
  execSync(command, { cwd, stdio: "pipe" });
}

function createRepoWithWorktree(): { repoDir: string; worktreeDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "opencode-mem-scope-"));
  createdDirs.push(repoDir);

  run("git init", repoDir);
  run("git config user.email test@example.com", repoDir);
  run("git config user.name Test User", repoDir);

  writeFileSync(join(repoDir, "README.md"), "# test\n", "utf-8");
  run("git add README.md", repoDir);
  run('git commit -m "init"', repoDir);

  const worktreeRoot = join(repoDir, ".worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const worktreeDir = join(worktreeRoot, "feature-a");
  run(`git worktree add "${worktreeDir}" -b feature-a`, repoDir);

  return { repoDir, worktreeDir };
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("project scope identity", () => {
  it.skipIf(process.platform !== "win32")(
    "ignores repository-local Git command shims on Windows",
    () => {
      for (const extension of ["bat", "cmd"]) {
        const repoDir = mkdtempSync(join(tmpdir(), `opencode-mem-git-shim-${extension}-`));
        createdDirs.push(repoDir);
        run("git init", repoDir);

        const sentinel = join(repoDir, "shim-executed.txt");
        writeFileSync(
          join(repoDir, `git.${extension}`),
          `@echo off\r\n>"${sentinel}" echo executed\r\nexit /b 1\r\n`,
          "utf-8"
        );

        expect(getGitCommonDir(repoDir)).not.toBeNull();
        expect(existsSync(sentinel)).toBe(false);
      }
    }
  );

  it.skipIf(process.platform !== "win32")(
    "rejects Git executables elsewhere inside a nested repository",
    () => {
      const repoDir = mkdtempSync(join(tmpdir(), "opencode-mem-git-exe-"));
      createdDirs.push(repoDir);
      run("git init", repoDir);
      run("git config user.email nested@example.com", repoDir);
      const nestedDir = join(repoDir, "src", "nested");
      const fakeBin = join(repoDir, "tools");
      mkdirSync(nestedDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });

      copyFileSync(
        join(process.env.SystemRoot!, "System32", "where.exe"),
        join(fakeBin, "git.exe")
      );
      const oldPath = process.env.PATH;
      try {
        process.env.PATH = `${fakeBin};${oldPath ?? ""}`;
        expect(getGitCommonDir(nestedDir)).toBe(getGitCommonDir(repoDir));
        expect(getTags(repoDir).user.userEmail).toBe("nested@example.com");
      } finally {
        process.env.PATH = oldPath;
      }
    }
  );

  it.skipIf(process.platform !== "win32")(
    "preserves trusted Git command wrappers outside the repository",
    () => {
      const repoDir = mkdtempSync(join(tmpdir(), "opencode-mem-git-wrapper-repo-"));
      const wrapperDir = mkdtempSync(join(tmpdir(), "opencode-mem-git-wrapper-bin-"));
      createdDirs.push(repoDir, wrapperDir);
      run("git init", repoDir);
      const realGit = execSync("where.exe git.exe", { encoding: "utf-8" })
        .trim()
        .split(/\r?\n/)[0]!;
      writeFileSync(join(wrapperDir, "git.cmd"), `@"${realGit}" %*\r\n`, "utf-8");

      const oldPath = process.env.PATH;
      try {
        process.env.PATH = wrapperDir;
        expect(normalize(realpathSync.native(getGitTopLevel(repoDir)!))).toBe(
          normalize(realpathSync.native(repoDir))
        );
      } finally {
        process.env.PATH = oldPath;
      }
    }
  );

  it("uses one project tag across worktrees in the same repo", () => {
    const { repoDir, worktreeDir } = createRepoWithWorktree();

    const mainCommonDir = getGitCommonDir(repoDir);
    const worktreeCommonDir = getGitCommonDir(worktreeDir);
    const mainTag = getProjectTagInfo(repoDir);
    const worktreeTag = getProjectTagInfo(worktreeDir);

    expect(mainCommonDir).toBe(worktreeCommonDir);
    expect(mainTag.tag).toBe(worktreeTag.tag);
    expect(mainTag.projectPath).toBe(worktreeTag.projectPath);
    expect(mainTag.projectName).toBe(basename(repoDir));
  });

  it("uses different project tags for unrelated non-git directories", () => {
    const left = mkdtempSync(join(tmpdir(), "opencode-mem-left-"));
    const right = mkdtempSync(join(tmpdir(), "opencode-mem-right-"));
    createdDirs.push(left, right);

    const leftTag = getProjectTagInfo(left);
    const rightTag = getProjectTagInfo(right);

    expect(leftTag.tag).not.toBe(rightTag.tag);
  });

  it("uses the same project tag from nested paths inside the same repo", () => {
    const { repoDir } = createRepoWithWorktree();
    const nestedDir = join(repoDir, "src", "features", "memory");
    mkdirSync(nestedDir, { recursive: true });

    const rootTag = getProjectTagInfo(repoDir);
    const nestedTag = getProjectTagInfo(nestedDir);

    expect(rootTag.tag).toBe(nestedTag.tag);
    expect(rootTag.projectPath).toBe(nestedTag.projectPath);
  });
});

describe("project marker (.opencode-mem-project)", () => {
  // Build a workspace containing several independent git repositories, like a
  // tree managed by Google `repo` or a monorepo checkout. Without a marker
  // each sub-repo is its own project; with one they all collapse onto the
  // workspace root.
  function createMultiRepoWorkspace(): {
    workspaceDir: string;
    repoA: string;
    repoB: string;
  } {
    const workspaceDir = mkdtempSync(join(tmpdir(), "opencode-mem-ws-"));
    createdDirs.push(workspaceDir);
    const repoA = join(workspaceDir, "repo-a");
    const repoB = join(workspaceDir, "repo-b");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      run("git init", repo);
      run("git config user.email test@example.com", repo);
      run("git config user.name Test User", repo);
    }
    return { workspaceDir, repoA, repoB };
  }

  it("without a marker, sibling git repos get separate project tags", () => {
    const { repoA, repoB } = createMultiRepoWorkspace();

    expect(getProjectTagInfo(repoA).tag).not.toBe(getProjectTagInfo(repoB).tag);
  });

  it("collapses nested git repos onto the marker root", () => {
    const { workspaceDir, repoA, repoB } = createMultiRepoWorkspace();
    writeFileSync(join(workspaceDir, ".opencode-mem-project"), "");

    const rootTag = getProjectTagInfo(workspaceDir);
    const aTag = getProjectTagInfo(repoA);
    const bTag = getProjectTagInfo(repoB);

    expect(aTag.tag).toBe(rootTag.tag);
    expect(bTag.tag).toBe(rootTag.tag);
    expect(aTag.tag).toBe(bTag.tag);
    expect(aTag.projectPath).toBe(workspaceDir);
    expect(aTag.projectName).toBe(basename(workspaceDir));
  });

  it("resolves deep nested paths up to the marker root", () => {
    const { workspaceDir, repoA } = createMultiRepoWorkspace();
    writeFileSync(join(workspaceDir, ".opencode-mem-project"), "");
    const deep = join(repoA, "src", "features", "memory");
    mkdirSync(deep, { recursive: true });

    const deepTag = getProjectTagInfo(deep);
    const rootTag = getProjectTagInfo(workspaceDir);

    expect(deepTag.tag).toBe(rootTag.tag);
    expect(deepTag.projectPath).toBe(workspaceDir);
  });

  it("the marker wins over an inner git repo and drops its remote url", () => {
    const { workspaceDir, repoA } = createMultiRepoWorkspace();
    // Give the inner repo a remote so we can assert it is intentionally ignored
    // once the workspace marker takes over identity.
    run("git remote add origin https://example.com/repo-a.git", repoA);
    writeFileSync(join(workspaceDir, ".opencode-mem-project"), "");

    const tag = getProjectTagInfo(repoA);

    expect(tag.projectPath).toBe(workspaceDir);
    expect(tag.gitRepoUrl).toBeUndefined();
  });

  it("findMarkerProjectRoot returns null without a marker, the ancestor when present", () => {
    const { workspaceDir, repoA } = createMultiRepoWorkspace();

    expect(findMarkerProjectRoot(repoA)).toBeNull();

    writeFileSync(join(workspaceDir, ".opencode-mem-project"), "");
    expect(findMarkerProjectRoot(repoA)).toBe(workspaceDir);
    // A session started exactly at the marker root still resolves to itself.
    expect(findMarkerProjectRoot(workspaceDir)).toBe(workspaceDir);
  });
});
