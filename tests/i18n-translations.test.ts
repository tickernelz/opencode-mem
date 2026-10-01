import { describe, expect, test } from "bun:test";
import { translations, type Lang } from "../web/src/lib/i18n/translations";

function keysOf(lang: Lang): string[] {
  return Object.keys(translations[lang]).sort();
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!).sort();
}

describe("i18n translations", () => {
  const langs = Object.keys(translations) as Lang[];
  const enKeys = keysOf("en");

  test("includes Turkish in the language catalog", () => {
    expect(langs).toContain("tr");
  });

  test("every language has exactly the English keys", () => {
    for (const lang of langs) {
      expect(keysOf(lang)).toEqual(enKeys);
    }
  });

  test("placeholder names match English for every key", () => {
    for (const lang of langs) {
      if (lang === "en") continue;
      for (const key of enKeys) {
        const enText = translations.en[key as keyof typeof translations.en] as string;
        const text = (translations[lang] as Record<string, string>)[key] ?? "";
        expect(placeholders(text)).toEqual(placeholders(enText));
      }
    }
  });

  test("translation values are non-empty strings", () => {
    for (const lang of langs) {
      for (const key of enKeys) {
        const text = (translations[lang] as Record<string, string>)[key];
        expect(typeof text).toBe("string");
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
