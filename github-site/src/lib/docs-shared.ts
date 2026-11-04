export const LOCALES = ["de", "zh", "ar", "tr", "nl"] as const;
export type DocsLocale = (typeof LOCALES)[number] | "en";

export function isDocsLocale(value: string): value is (typeof LOCALES)[number] {
  return (LOCALES as readonly string[]).includes(value);
}

export function docsHref(lang: string, slug: string): string {
  const base = [lang, "docs", slug].filter(Boolean).join("/");
  return `/${base}/`;
}
