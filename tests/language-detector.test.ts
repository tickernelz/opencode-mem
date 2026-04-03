import { describe, it, expect } from "bun:test";
import { detectLanguage, getLanguageName } from "../src/services/language-detector.js";

describe("detectLanguage", () => {
  it("should detect Chinese as zh", () => {
    expect(detectLanguage("这是一个中文测试")).toBe("zh");
  });

  it("should detect short Chinese as zh (5+ chars)", () => {
    expect(detectLanguage("这是一个中文测试")).toBe("zh");
  });

  it("should detect English as en", () => {
    expect(detectLanguage("This is an English test")).toBe("en");
  });

  it("should fallback to en for empty string", () => {
    expect(detectLanguage("")).toBe("en");
  });

  it("should fallback to en for whitespace only", () => {
    expect(detectLanguage("   ")).toBe("en");
  });

  it("should fallback to en for very short undetectable input", () => {
    expect(detectLanguage("ab")).toBe("en");
  });
});

describe("getLanguageName", () => {
  it("should return Chinese name for zh", () => {
    const name = getLanguageName("zh");
    expect(name.toLowerCase()).toContain("chinese");
  });

  it("should return English name for en", () => {
    const name = getLanguageName("en");
    expect(name.toLowerCase()).toContain("english");
  });

  it("should fallback to English for unknown code", () => {
    expect(getLanguageName("xyz")).toBe("English");
  });
});
