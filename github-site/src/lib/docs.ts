import { getCollection, type CollectionEntry } from "astro:content";
import map from "../../docs-map.json";
import { docsHref, isDocsLocale, LOCALES, type DocsLocale } from "./docs-shared";

export type DocsEntry = CollectionEntry<"docs">;
export { docsHref, isDocsLocale, LOCALES, type DocsLocale };

/** Normalize collection id → `{ lang, slug }` where slug is under /docs/. */
export function entryRoute(id: string): { lang: string; slug: string } {
  const clean = id.replace(/\/index$/, "").replace(/\.md$/, "");
  const parts = clean.split("/");
  if (parts[0] && isDocsLocale(parts[0]) && parts[1] === "docs") {
    return { lang: parts[0], slug: parts.slice(2).join("/") };
  }
  if (parts[0] === "docs") {
    return { lang: "", slug: parts.slice(1).join("/") };
  }
  return { lang: "", slug: clean };
}

export function sidebarGroups(lang: string) {
  const groups = [...new Set(map.pages.map((page) => page.group))];
  return groups.map((label) => ({
    label,
    items: map.pages
      .filter((page) => page.group === label)
      .map((page) => ({
        title: page.title ?? page.sections[0] ?? page.slug,
        href: docsHref(lang, page.slug),
        slug: page.slug,
      })),
  }));
}

export async function allDocsPaths(): Promise<
  Array<{ lang: string; slug: string; entry: DocsEntry }>
> {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({ ...entryRoute(entry.id), entry }));
}

export async function findDocsEntry(lang: string, slug: string): Promise<DocsEntry | undefined> {
  const paths = await allDocsPaths();
  return paths.find((p) => p.lang === lang && p.slug === slug)?.entry;
}

export { map as docsMap };
