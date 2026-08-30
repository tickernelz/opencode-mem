import { describe, expect, test } from "bun:test";
import { getDisplayedMemoryCount } from "../web/src/lib/memory-count";

describe("getDisplayedMemoryCount", () => {
  test("shows matched results while search is active", () => {
    expect(getDisplayedMemoryCount(true, 3, 120)).toBe(3);
    expect(getDisplayedMemoryCount(true, 0, 120)).toBe(0);
  });

  test("restores the store total when search is cleared", () => {
    expect(getDisplayedMemoryCount(false, 3, 120)).toBe(120);
  });
});
