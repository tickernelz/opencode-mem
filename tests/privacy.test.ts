import { describe, it, expect } from "bun:test";
import { stripPrivateContent, isFullyPrivate } from "../src/services/privacy.js";

describe("privacy", () => {
  describe("stripPrivateContent", () => {
    it("should replace <private> tags with [REDACTED]", () => {
      const input = "Hello <private>secret data</private> world";
      const result = stripPrivateContent(input);
      expect(result).toBe("Hello [REDACTED] world");
    });

    it("should handle multiple <private> tags", () => {
      const input = "<private>first</private> and <private>second</private>";
      const result = stripPrivateContent(input);
      expect(result).toBe("[REDACTED] and [REDACTED]");
    });

    it("should be case-insensitive", () => {
      const input = "<PRIVATE>secret</PRIVATE>";
      const result = stripPrivateContent(input);
      expect(result).toBe("[REDACTED]");
    });

    it("should handle multiline content inside tags", () => {
      const input = "<private>\nline1\nline2\n</private>";
      const result = stripPrivateContent(input);
      expect(result).toBe("[REDACTED]");
    });

    it("should return unchanged string when no tags present", () => {
      const input = "no private content here";
      const result = stripPrivateContent(input);
      expect(result).toBe("no private content here");
    });

    it("should handle empty string", () => {
      const result = stripPrivateContent("");
      expect(result).toBe("");
    });

    it("should handle adjacent private tags", () => {
      const input = "<private>a</private><private>b</private>";
      const result = stripPrivateContent(input);
      expect(result).toBe("[REDACTED][REDACTED]");
    });
  });

  describe("isFullyPrivate", () => {
    it("should return true when content is only a private tag", () => {
      const result = isFullyPrivate("<private>secret</private>");
      expect(result).toBe(true);
    });

    it("should return true for empty string", () => {
      const result = isFullyPrivate("");
      expect(result).toBe(true);
    });

    it("should return true when content is only whitespace around a private tag", () => {
      const result = isFullyPrivate("  <private>secret</private>  ");
      expect(result).toBe(true);
    });

    it("should return false when non-private content exists", () => {
      const result = isFullyPrivate("visible <private>secret</private>");
      expect(result).toBe(false);
    });

    it("should return false for plain text", () => {
      const result = isFullyPrivate("just normal text");
      expect(result).toBe(false);
    });
  });
});
