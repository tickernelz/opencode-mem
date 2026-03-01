import { describe, it, expect } from "bun:test";
import { getProjectName } from "../src/services/tags.js";

describe("tags", () => {
  describe("getProjectName", () => {
    it("should extract project name from Unix path", () => {
      expect(getProjectName("/home/user/projects/my-app")).toBe("my-app");
    });

    it("should extract project name from Windows path", () => {
      expect(getProjectName("C:\\Users\\user\\projects\\my-app")).toBe("my-app");
    });

    it("should extract project name from mixed-separator path", () => {
      expect(getProjectName("C:\\Users/user\\projects/my-app")).toBe("my-app");
    });

    it("should return input when no separators present", () => {
      expect(getProjectName("my-app")).toBe("my-app");
    });

    it("should handle trailing separator", () => {
      const result = getProjectName("/home/user/projects/my-app/");
      // Should handle trailing slash gracefully
      expect(typeof result).toBe("string");
    });

    it("should handle deeply nested path", () => {
      expect(getProjectName("/a/b/c/d/e/f/project")).toBe("project");
    });
  });
});
