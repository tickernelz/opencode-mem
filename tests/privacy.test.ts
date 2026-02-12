import { describe, it, expect } from "bun:test";
import { isFullyPrivate, stripPrivateContent } from "../src/services/privacy.js";

describe("Privacy Service", () => {
  describe("stripPrivateContent", () => {
    it("removes private content blocks", () => {
      const content = "Public <private>secret</private> visible";
      expect(stripPrivateContent(content)).toBe("Public [REDACTED] visible");
    });

    it("handles multiple private blocks", () => {
      const content = "A <private>one</private> B <private>two</private> C";
      expect(stripPrivateContent(content)).toBe("A [REDACTED] B [REDACTED] C");
    });

    it("is case-insensitive for private tags", () => {
      const content = "Start <PRIVATE>hidden</PRIVATE> End";
      expect(stripPrivateContent(content)).toBe("Start [REDACTED] End");
    });
  });

  describe("isFullyPrivate", () => {
    it("returns true when all content is private", () => {
      const content = "<private>only secret</private>";
      expect(isFullyPrivate(content)).toBe(true);
    });

    it("returns false when non-private content exists", () => {
      const content = "prefix <private>secret</private> suffix";
      expect(isFullyPrivate(content)).toBe(false);
    });
  });
});
