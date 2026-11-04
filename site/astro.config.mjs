import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { en } from "./src/i18n/en.ts";

const map = JSON.parse(readFileSync(new URL("./docs-map.json", import.meta.url), "utf8"));
const groups = [...new Set(map.pages.map((page) => page.group))];
const sidebar = groups.map((label) => ({
  label,
  items: map.pages
    .filter((page) => page.group === label)
    .map((page) => ({ slug: page.slug ? `docs/${page.slug}` : "docs" })),
}));

export default defineConfig({
  site: "https://opencode-mem.zhafron.my.id",
  base: "/",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "opencode-mem",
      description:
        "Long-term memory for OpenCode agents. Docs generated from the opencode-mem README.",
      logo: { src: "./src/assets/brain.svg", alt: "" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: map.repository }],
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
        zh: { label: "简体中文", lang: "zh-CN" },
        ar: { label: "العربية", lang: "ar", dir: "rtl" },
        tr: { label: "Türkçe", lang: "tr" },
        nl: { label: "Nederlands", lang: "nl" },
      },
      sidebar,
      lastUpdated: true,
      customCss: ["./src/generated/tokens.css", "./src/styles/fonts.css", "./src/styles/docs.css"],
      components: {
        Head: "./src/components/docs/Head.astro",
        SiteTitle: "./src/components/docs/SiteTitle.astro",
      },
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "32x32" } },
        {
          tag: "meta",
          attrs: { property: "og:image", content: "https://opencode-mem.zhafron.my.id/og.png" },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: en.meta.ogImageAlt } },
        { tag: "meta", attrs: { name: "twitter:image:alt", content: en.meta.ogImageAlt } },
      ],
    }),
  ],
});
