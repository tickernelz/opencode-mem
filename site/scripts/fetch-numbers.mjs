import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = resolve(dirname(fileURLToPath(import.meta.url)), "../src/data/numbers.json");
const repo = "tickernelz/opencode-mem";
const pkg = "opencode-mem";

async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

const github = { accept: "application/vnd.github+json", "user-agent": "opencode-mem-site" };
if (process.env.GITHUB_TOKEN) github.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

try {
  const [repository, year, month, registry] = await Promise.all([
    json(`https://api.github.com/repos/${repo}`, github),
    json(`https://api.npmjs.org/downloads/point/last-year/${pkg}`),
    json(`https://api.npmjs.org/downloads/point/last-month/${pkg}`),
    json(`https://registry.npmjs.org/${pkg}`, { accept: "application/vnd.npm.install-v1+json" }),
  ]);
  const numbers = {
    fetchedAt: new Date().toISOString().slice(0, 10),
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    license: repository.license?.spdx_id ?? "MIT",
    version: registry["dist-tags"].latest,
    releases: Object.keys(registry.versions).length,
    downloadsYear: year.downloads,
    downloadsYearRange: `${year.start}..${year.end}`,
    downloadsMonth: month.downloads,
    downloadsMonthRange: `${month.start}..${month.end}`,
  };
  for (const [key, value] of Object.entries(numbers)) {
    if (value === undefined || value === null || Number.isNaN(value)) {
      throw new Error(`numbers: ${key} missing from API response`);
    }
  }
  await writeFile(target, `${JSON.stringify(numbers, null, 2)}\n`);
  console.log(`numbers: refreshed (${numbers.fetchedAt})`);
} catch (error) {
  const kept = JSON.parse(await readFile(target, "utf8"));
  console.warn(`numbers: fetch failed (${error.message}); keeping snapshot from ${kept.fetchedAt}`);
}
