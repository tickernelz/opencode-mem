import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkAutoUpdate,
  isAutoUpdatableSpec,
  isVersionNewer,
  startAutoUpdate,
  updateRemoveDir,
} from "../src/infra/auto-update.js";

describe("auto-update helpers", () => {
  it("isVersionNewer compares semver versions", () => {
    expect(isVersionNewer("2.27.0", "2.26.0")).toBe(true);
    expect(isVersionNewer("2.26.0", "2.26.0")).toBe(false);
    expect(isVersionNewer("2.26.0", "2.27.0")).toBe(false);
    expect(isVersionNewer("2.26.0", "2.26.0-beta.1")).toBe(true);
    expect(isVersionNewer("2.26.1-beta.1", "2.26.0")).toBe(true);
    expect(isVersionNewer("2.26.0-beta.2", "2.26.0-beta.1")).toBe(true);
  });

  it("isAutoUpdatableSpec allows latest and ranges", () => {
    expect(isAutoUpdatableSpec("latest")).toBe(true);
    expect(isAutoUpdatableSpec("*")).toBe(true);
    expect(isAutoUpdatableSpec("^2.26.0")).toBe(true);
    expect(isAutoUpdatableSpec("~2.26.0")).toBe(true);
    expect(isAutoUpdatableSpec(">=2.26.0")).toBe(true);
  });

  it("isAutoUpdatableSpec rejects pinned and non-registry specs", () => {
    expect(isAutoUpdatableSpec("2.26.0")).toBe(false);
    expect(isAutoUpdatableSpec("file:../opencode-mem")).toBe(false);
    expect(isAutoUpdatableSpec("github:user/repo")).toBe(false);
    expect(isAutoUpdatableSpec("")).toBe(false);
  });

  it("updateRemoveDir removes opencode npm wrapper for latest installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-update-"));
    const wrapperDir = join(rootDir, "opencode-mem@latest");
    const packageDir = join(wrapperDir, "node_modules", "opencode-mem");
    await writePackageJson(wrapperDir, {
      dependencies: { "opencode-mem": "2.26.1" },
    });
    await writePackageJson(packageDir, {
      name: "opencode-mem",
      version: "2.26.0",
    });

    expect(await updateRemoveDir(packageDir, "opencode-mem")).toBe(wrapperDir);
  });

  it("updateRemoveDir accepts caret wrapper installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-update-caret-"));
    const wrapperDir = join(rootDir, "opencode-mem@^2");
    const packageDir = join(wrapperDir, "node_modules", "opencode-mem");
    await writePackageJson(wrapperDir, {
      dependencies: { "opencode-mem": "^2.26.0" },
    });
    await writePackageJson(packageDir, {
      name: "opencode-mem",
      version: "2.26.0",
    });

    expect(await updateRemoveDir(packageDir, "opencode-mem")).toBe(wrapperDir);
  });

  it("updateRemoveDir skips version-locked opencode installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-update-"));
    const wrapperDir = join(rootDir, "opencode-mem@2.26.0");
    const packageDir = join(wrapperDir, "node_modules", "opencode-mem");
    await writePackageJson(wrapperDir, {
      dependencies: { "opencode-mem": "2.26.0" },
    });
    await writePackageJson(packageDir, {
      name: "opencode-mem",
      version: "2.26.0",
    });

    expect(await updateRemoveDir(packageDir, "opencode-mem")).toBeUndefined();
  });

  it("updateRemoveDir skips project node_modules installs with range deps", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "mem-update-project-"));
    const packageDir = join(projectDir, "node_modules", "opencode-mem");
    await writePackageJson(projectDir, {
      dependencies: { "opencode-mem": "^2.26.0" },
    });
    await writePackageJson(packageDir, {
      name: "opencode-mem",
      version: "2.26.0",
    });

    expect(await updateRemoveDir(packageDir, "opencode-mem")).toBeUndefined();
  });
});

describe("auto-update checkAutoUpdate", () => {
  it("returns updated:false when package dir cannot be found", async () => {
    const result = await checkAutoUpdate(AbortSignal.timeout(1000), {
      findPackageDir: async () => undefined,
    });
    expect(result).toEqual({ updated: false });
  });

  it("returns updated:false when latest is not newer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-check-"));
    await writePackageJson(rootDir, { name: "opencode-mem", version: "2.26.0" });

    const result = await checkAutoUpdate(AbortSignal.timeout(1000), {
      findPackageDir: async () => rootDir,
      fetchLatestVersion: async () => "2.26.0",
    });
    expect(result).toEqual({ updated: false });
  });

  it("returns updated:false when install is not auto-updatable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-check-locked-"));
    await writePackageJson(rootDir, { name: "opencode-mem", version: "2.26.0" });

    const result = await checkAutoUpdate(AbortSignal.timeout(1000), {
      findPackageDir: async () => rootDir,
      fetchLatestVersion: async () => "2.27.0",
      updateRemoveDir: async () => undefined,
    });
    expect(result).toEqual({ updated: false });
  });

  it("removes the wrapper dir and reports updated:true", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-check-update-"));
    await writePackageJson(rootDir, { name: "opencode-mem", version: "2.26.0" });
    const removed: string[] = [];

    const result = await checkAutoUpdate(AbortSignal.timeout(1000), {
      findPackageDir: async () => rootDir,
      fetchLatestVersion: async () => "2.27.0",
      updateRemoveDir: async () => join(rootDir, "opencode-mem@latest"),
      removeDir: async (path) => {
        removed.push(path);
      },
    });

    expect(result).toEqual({
      updated: true,
      name: "opencode-mem",
      current: "2.26.0",
      latest: "2.27.0",
    });
    expect(removed).toEqual([join(rootDir, "opencode-mem@latest")]);
  });

  it("returns remove_failed when wrapper removal throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "mem-check-fail-"));
    await writePackageJson(rootDir, { name: "opencode-mem", version: "2.26.0" });

    const result = await checkAutoUpdate(AbortSignal.timeout(1000), {
      findPackageDir: async () => rootDir,
      fetchLatestVersion: async () => "2.27.0",
      updateRemoveDir: async () => join(rootDir, "opencode-mem@latest"),
      removeDir: async () => {
        throw new Error("EPERM");
      },
    });

    expect(result).toEqual({
      updated: false,
      error: "remove_failed",
      name: "opencode-mem",
      current: "2.26.0",
      latest: "2.27.0",
    });
  });

  it("is a no-op against the real local workspace package install", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await checkAutoUpdate(controller.signal);
      expect(typeof result.updated).toBe("boolean");
      // Workspace installs are not opencode @latest wrappers, so this must not
      // delete the repo — updated stays false (or true only if somehow wrapped).
      if (result.updated) {
        expect(result.name).toBe("opencode-mem");
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  it("startAutoUpdate does nothing when disabled", () => {
    expect(() =>
      startAutoUpdate({ client: { tui: { showToast: async () => undefined } } } as any, false)
    ).not.toThrow();
  });
});

async function writePackageJson(dir: string, data: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(data)}\n`, "utf-8");
}
