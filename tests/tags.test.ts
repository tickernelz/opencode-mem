import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const childProcessModulePath = "node:child_process";
const tagsModulePath = new URL("../src/services/tags.js", import.meta.url).pathname;
const configModulePath = new URL("../src/config.js", import.meta.url).pathname;

mock.module(configModulePath, () => ({
  CONFIG: {
    containerTagPrefix: "opencode",
    userEmailOverride: undefined,
    userNameOverride: undefined,
  },
}));

const execSyncMock = mock((command: string, options?: { cwd?: string }) => {
  if (command === "git config user.email") {
    return "dev@example.com\n";
  }

  if (command === "git config user.name") {
    return "Dev User\n";
  }

  if (command === "git config --get remote.origin.url") {
    if (options?.cwd === "/tmp/my-project") {
      return "git@github.com:tickernelz/opencode-mem.git\n";
    }
  }

  throw new Error(`Unhandled command: ${command}`);
});

mock.module(childProcessModulePath, () => ({
  execSync: execSyncMock,
}));

const { getTags } = await import(tagsModulePath);

describe("Tags Service", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((command: string, options?: { cwd?: string }) => {
      if (command === "git config user.email") {
        return "dev@example.com\n";
      }

      if (command === "git config user.name") {
        return "Dev User\n";
      }

      if (command === "git config --get remote.origin.url") {
        if (options?.cwd === "/tmp/my-project") {
          return "git@github.com:tickernelz/opencode-mem.git\n";
        }
      }

      throw new Error(`Unhandled command: ${command}`);
    });
  });

  afterEach(() => {
    execSyncMock.mockClear();
  });

  describe("getTags", () => {
    it("returns expected structure", () => {
      const result = getTags("/tmp/my-project");

      expect(result).toHaveProperty("user");
      expect(result).toHaveProperty("project");

      expect(result.user.tag).toMatch(/^opencode_user_[a-f0-9]{16}$/);
      expect(result.user.displayName).toBe("Dev User");
      expect(result.user.userName).toBe("Dev User");
      expect(result.user.userEmail).toBe("dev@example.com");

      expect(result.project.tag).toMatch(/^opencode_project_[a-f0-9]{16}$/);
      expect(result.project.displayName).toBe("/tmp/my-project");
      expect(result.project.projectPath).toBe("/tmp/my-project");
      expect(result.project.projectName).toBe("my-project");
      expect(result.project.gitRepoUrl).toBe("git@github.com:tickernelz/opencode-mem.git");
    });

    it("handles missing git gracefully", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("git not found");
      });

      const result = getTags("/tmp/no-git-project");

      expect(result.user.tag).toMatch(/^opencode_user_[a-f0-9]{16}$/);
      expect(result.user.displayName.length).toBeGreaterThan(0);
      expect(result.user.userEmail).toBeUndefined();

      expect(result.project.tag).toMatch(/^opencode_project_[a-f0-9]{16}$/);
      expect(result.project.projectPath).toBe("/tmp/no-git-project");
      expect(result.project.projectName).toBe("no-git-project");
      expect(result.project.gitRepoUrl).toBeUndefined();
    });
  });
});
