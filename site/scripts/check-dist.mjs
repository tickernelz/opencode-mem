import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(site, "dist");
const map = JSON.parse(await readFile(join(site, "docs-map.json"), "utf8"));
const failures = [];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if ((await readFile(join(dist, "CNAME"), "utf8")).trim() !== "opencode-mem.zhafron.my.id") {
  failures.push("dist/CNAME must contain opencode-mem.zhafron.my.id");
}
for (const page of map.pages) {
  const file = join(dist, "docs", page.slug, "index.html");
  if (!(await exists(file))) failures.push(`missing docs page ${file}`);
}
for (const required of [
  "index.html",
  "404.html",
  "pagefind/pagefind.js",
  "sitemap-index.xml",
  "og.png",
]) {
  if (!(await exists(join(dist, required)))) failures.push(`missing dist/${required}`);
}

const landing = await readFile(join(dist, "index.html"), "utf8");
const scripts = [...landing.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
let eagerJs = 0;
for (const src of scripts) eagerJs += (await stat(join(dist, src))).size;
const inline = [...landing.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].reduce(
  (n, m) => n + m[1].length,
  0
);
const lazy = (await readdir(join(dist, "_astro"))).filter((f) => f.startsWith("memory-field"));
console.log(
  `landing: ${scripts.length} external script(s) ${eagerJs} B, inline ${inline} B, lazy chunk(s): ${lazy.join(", ")}`
);
if (eagerJs + inline > 12000)
  failures.push(`landing eager JS ${eagerJs + inline} B exceeds 12000 B budget`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `site: ${map.pages.length} English docs pages, CNAME, 404, search index, sitemap, og image present`
);
