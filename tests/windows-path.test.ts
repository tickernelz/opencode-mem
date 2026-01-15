import { describe, it, expect } from "bun:test";
import { getProjectName } from "../src/services/tags.js";
import { dirname } from "node:path";
import { join } from "node:path";
import * as fs from "node:fs";

describe("Windows Path Handling", () => {
  describe("getProjectName", () => {
    it("should handle Unix-style paths correctly", () => {
      const result = getProjectName("/home/user/projects/my-project");
      expect(result).toBe("my-project");
    });

    it("should handle Windows-style paths correctly", () => {
      const result = getProjectName("C:\\Users\\user\\projects\\my-project");
      expect(result).toBe("my-project");
    });

    it("should handle Windows-style paths with forward slashes", () => {
      const result = getProjectName("C:/Users/user/projects/my-project");
      expect(result).toBe("my-project");
    });

    it("should handle relative Windows paths", () => {
      const result = getProjectName("..\\projects\\my-project");
      expect(result).toBe("my-project");
    });

    it("should return the input if no path separators found", () => {
      const result = getProjectName("my-project");
      expect(result).toBe("my-project");
    });
  });

  describe("path.join for cache directory", () => {
    it("should join paths correctly on Windows", () => {
      const storagePath = "C:\\Users\\user\\.opencode-mem";
      const cacheDir = join(storagePath, ".cache");
      expect(cacheDir).toContain(".cache");
      expect(cacheDir).not.toContain("//");
    });

    it("should join paths correctly on Unix", () => {
      const storagePath = "/home/user/.opencode-mem";
      const cacheDir = join(storagePath, ".cache");
      expect(cacheDir).toContain(".cache");
      expect(cacheDir).not.toContain("//");
    });
  });

  describe("dirname for database path", () => {
    it("should extract directory correctly from Windows path", () => {
      const dbPath = "C:\\Users\\user\\.opencode-mem\\shards\\project.db";
      const dir = dirname(dbPath);
      expect(dir).toBe("C:\\Users\\user\\.opencode-mem\\shards");
    });

    it("should extract directory correctly from Unix path", () => {
      const dbPath = "/home/user/.opencode-mem/shards/project.db";
      const dir = dirname(dbPath);
      expect(dir).toBe("/home/user/.opencode-mem/shards");
    });

    it("should handle paths with mixed separators", () => {
      const dbPath = "C:\\Users\\user/.opencode-mem\\shards/project.db";
      const dir = dirname(dbPath);
      expect(dir).toContain("shards");
    });
  });

  describe("Web UI path normalization", () => {
    it("should normalize Windows backslashes to forward slashes", () => {
      const projectPath = "C:\\Users\\user\\projects\\my-project";
      const normalized = projectPath.replace(/\\/g, "/");
      const parts = normalized.split("/").filter((p) => p);
      expect(parts[parts.length - 1]).toBe("my-project");
    });

    it("should handle Unix paths without modification", () => {
      const projectPath = "/home/user/projects/my-project";
      const normalized = projectPath.replace(/\\/g, "/");
      const parts = normalized.split("/").filter((p) => p);
      expect(parts[parts.length - 1]).toBe("my-project");
    });

    it("should handle mixed path separators", () => {
      const projectPath = "C:\\Users/user/projects\\my-project";
      const normalized = projectPath.replace(/\\/g, "/");
      const parts = normalized.split("/").filter((p) => p);
      expect(parts[parts.length - 1]).toBe("my-project");
    });
  });
});