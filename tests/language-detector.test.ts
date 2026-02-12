import { describe, expect, it, mock } from "bun:test";

mock.module("franc-min", () => ({
  franc: (text: string) => (/[^\x00-\x7F]/.test(text) ? "cmn" : "eng"),
}));

mock.module("iso-639-3", () => ({
  iso6393: [
    { iso6391: "en", name: "English" },
    { iso6391: "zh", name: "Chinese" },
  ],
  iso6393To1: {
    eng: "en",
    cmn: "zh",
  },
}));

const languageModulePath = new URL("../src/services/language-detector.js", import.meta.url)
  .pathname;
const { detectLanguage, getLanguageName } = await import(languageModulePath);

describe("Language Detector Service", () => {
  describe("detectLanguage", () => {
    it("detects English text", () => {
      const text =
        "This is a long English sentence used for language detection and it should be recognized correctly.";
      expect(detectLanguage(text)).toBe("en");
    });

    it("detects Chinese text", () => {
      const text = "这是一个用于语言检测的中文句子，应该被正确识别为中文语言。";
      expect(detectLanguage(text)).toBe("zh");
    });
  });

  describe("getLanguageName", () => {
    it("returns correct language names", () => {
      expect(getLanguageName("en")).toBe("English");
      expect(getLanguageName("zh")).toBe("Chinese");
    });
  });
});
