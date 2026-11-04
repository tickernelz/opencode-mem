import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(site, "..");
const map = JSON.parse(await readFile(resolve(site, "docs-map.json"), "utf8"));
const outRoot = resolve(site, "src/content/docs");
const failures = [];

function parse(markdown) {
  const lines = markdown.split("\n");
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ level: heading[1].length, text: heading[2], line: index });
  });
  const slugger = new GithubSlugger();
  for (const [i, heading] of headings.entries()) {
    heading.anchor = slugger.slug(heading.text);
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length;
    heading.body = lines.slice(heading.line + 1, end);
  }
  return headings;
}

function lastChange(file) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

const english = parse(await readFile(resolve(repo, map.source), "utf8"));
const claimed = new Map();
for (const page of map.pages) {
  for (const section of page.sections) {
    if (!english.some((h) => h.text === section))
      failures.push(`docs-map.json: "${section}" is not a heading in ${map.source}`);
    if (claimed.has(section)) failures.push(`docs-map.json: "${section}" is mapped twice`);
    claimed.set(section, page);
  }
}
for (const heading of english) {
  if (!claimed.has(heading.text)) {
    failures.push(
      `${map.source}:${heading.line + 1}: heading "${heading.text}" is not mapped in site/docs-map.json`
    );
  }
}

function alignTranslation(lang, translated) {
  const expected = english.filter((h) => !(map.untranslated[h.text] ?? []).includes(lang));
  if (expected.length !== translated.length) {
    failures.push(
      `${map.translations[lang]}: ${translated.length} headings, expected ${expected.length} (README has ${english.length}; list untranslated sections in docs-map.json "untranslated")`
    );
    return null;
  }
  const byEnglish = new Map();
  expected.forEach((heading, i) => {
    if (heading.level !== translated[i].level) {
      failures.push(
        `${map.translations[lang]}:${translated[i].line + 1}: "${translated[i].text}" is h${translated[i].level}, README "${heading.text}" is h${heading.level}`
      );
    }
    byEnglish.set(heading.text, translated[i]);
  });
  return byEnglish;
}

const languages = [
  { lang: "", file: map.source, sections: new Map(english.map((h) => [h.text, h])) },
];
for (const [lang, file] of Object.entries(map.translations)) {
  const aligned = alignTranslation(lang, parse(await readFile(resolve(repo, file), "utf8")));
  if (aligned) languages.push({ lang, file, sections: aligned });
}

function route(lang, slug) {
  return `/${[lang, "docs", slug].filter(Boolean).join("/")}/`;
}

function anchorTargets(sections, lang) {
  const targets = new Map();
  for (const page of map.pages) {
    const pageSlugger = new GithubSlugger();
    page.sections.forEach((name, i) => {
      const heading = sections.get(name);
      if (!heading) return;
      const href = route(lang, page.slug);
      targets.set(heading.anchor, i === 0 ? href : `${href}#${pageSlugger.slug(heading.text)}`);
    });
  }
  return targets;
}

const englishTargets = anchorTargets(languages[0].sections, "");
const dropLines = map.dropLines.map((pattern) => new RegExp(pattern));

function rewriteLinks(text, file, targets, lang, slug) {
  return text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang, label, href) => {
    if (/^[a-z]+:/i.test(href) || href.startsWith("//")) return whole;
    if (href.startsWith("#")) {
      const target =
        targets.get(href.slice(1)) ?? (lang ? englishTargets.get(href.slice(1)) : undefined);
      if (!target) {
        failures.push(
          `${file}: link "${href}" (docs page ${route(lang, slug)}) has no matching heading`
        );
        return whole;
      }
      return `${bang}[${label}](${target})`;
    }
    const path = posix.normalize(posix.join(posix.dirname(file), href.split("#")[0]));
    const kind = bang ? "raw" : "blob";
    const hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
    return `${bang}[${label}](${map.repository}/${kind}/main/${path}${hash})`;
  });
}

function demote(lines, shift) {
  let fence = null;
  return lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(
      /^(#{1,6})(\s)/,
      (_, hashes, space) => `${"#".repeat(Math.max(2, Math.min(6, hashes.length - shift)))}${space}`
    );
  });
}

function yaml(value) {
  return JSON.stringify(value);
}

function configKeys(body) {
  const keys = [];
  for (const line of body.split("\n")) {
    const cell = line.match(/^\|\s*([^|]+?)\s*\|/);
    if (!cell || /^[-:\s]+$/.test(cell[1])) continue;
    for (const [, key] of cell[1].matchAll(/`([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)`/g))
      keys.push(key);
  }
  return keys;
}

const configSource = (
  await Promise.all(map.configSources.map((f) => readFile(resolve(repo, f), "utf8")))
).join("\n");

await rm(outRoot, { recursive: true, force: true });
let written = 0;
for (const { lang, file, sections } of languages) {
  const targets = anchorTargets(sections, lang);
  const updated = lastChange(file);
  for (const page of map.pages) {
    const present = page.sections.map((name) => sections.get(name)).filter(Boolean);
    if (present.length === 0) continue;
    if (lang && present.length !== page.sections.length) continue;
    const [first, ...rest] = present;
    const title = lang || !page.title ? first.text.replace(/`/g, "") : page.title;
    const firstBody = first.body.filter((line) => !dropLines.some((re) => re.test(line)));
    const parts = [firstBody.join("\n")];
    for (const heading of rest) {
      const level = Math.max(2, heading.level - first.level + 1);
      parts.push(
        demote(
          [`${"#".repeat(level)} ${heading.text}`, ...heading.body],
          heading.level - level
        ).join("\n")
      );
    }
    let body = parts
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    body = rewriteLinks(body, file, targets, lang, page.slug);
    if (!lang && map.configPages.some((prefix) => `${page.slug}/`.startsWith(prefix))) {
      for (const key of configKeys(body)) {
        const leaf = key.split(".").at(-1);
        if (!new RegExp(`\\b${leaf}\\b`).test(configSource)) {
          failures.push(
            `docs page ${route("", page.slug)}: option \`${key}\` is not in ${map.configSources.join(" or ")}`
          );
        }
      }
    }
    const description = body
      .split("\n\n")
      .find((p) => p && !/^[#|`<>\-*!\d]/.test(p.trim()))
      ?.replace(/\s+/g, " ")
      .replace(/`|\*\*/g, "")
      .slice(0, 180);
    const frontmatter = [
      "---",
      `title: ${yaml(title)}`,
      description ? `description: ${yaml(description)}` : null,
      `editUrl: ${yaml(`${map.repository}/edit/main/${file}`)}`,
      updated ? `lastUpdated: ${updated}` : null,
      "sidebar:",
      `  order: ${map.pages.indexOf(page)}`,
      "---",
    ].filter(Boolean);
    const isIndex = page.slug === "" || map.pages.some((p) => p.slug.startsWith(`${page.slug}/`));
    const path = isIndex
      ? resolve(outRoot, lang, "docs", page.slug, "index.md")
      : resolve(outRoot, lang, "docs", `${page.slug}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${frontmatter.join("\n")}\n\n${body}\n`);
    written++;
  }
}

if (failures.length > 0) {
  console.error(`docs: ${failures.length} problem(s)\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`docs: ${written} pages from ${languages.length} README files`);
