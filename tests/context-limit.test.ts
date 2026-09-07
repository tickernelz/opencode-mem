import { describe, expect, it } from "bun:test";
import { sliceUtf8Bytes, truncateToMaxBytes, utf8ByteLength } from "../src/utils/context-limit.js";

describe("context-limit utilities (#232)", () => {
  it("counts UTF-8 bytes, not JS string length", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("ä")).toBe(2);
    expect(utf8ByteLength("你好")).toBe(6);
  });

  it("returns text unchanged when under the budget", () => {
    expect(truncateToMaxBytes("hello world", 100)).toBe("hello world");
  });

  it("keeps head and tail when truncating", () => {
    const text = "AAAA" + "x".repeat(200) + "BBBB";
    const truncated = truncateToMaxBytes(text, 40, "|TRUNC|");
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(40);
    expect(truncated.startsWith("AAAA")).toBe(true);
    expect(truncated.includes("|TRUNC|")).toBe(true);
    expect(truncated.endsWith("BBBB")).toBe(true);
  });

  it("slices multi-byte characters on UTF-8 boundaries", () => {
    const text = "ä".repeat(10);
    const sliced = sliceUtf8Bytes(text, 0, 3);
    expect(utf8ByteLength(sliced)).toBeLessThanOrEqual(3);
    expect(sliced.includes("�")).toBe(false);
  });
});
