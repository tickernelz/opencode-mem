/**
 * Live smoke for auto-update helpers + checkAutoUpdate paths.
 * Run: bun scripts/live-auto-update-smoke.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const { isVersionNewer, isAutoUpdatableSpec, updateRemoveDir, checkAutoUpdate, startAutoUpdate } =
  await import(join(root, "src/infra/auto-update.ts"));

assert.equal(isVersionNewer("2.27.0", "2.26.0"), true);
assert.equal(isAutoUpdatableSpec("latest"), true);
assert.equal(isAutoUpdatableSpec("2.26.0"), false);
console.log("✔ helpers");

const wrapper = mkdtempSync(join(tmpdir(), "mem-au-"));
const wrapDir = join(wrapper, "opencode-mem@latest");
const pkgDir = join(wrapDir, "node_modules", "opencode-mem");
mkdirSync(pkgDir, { recursive: true });
writeFileSync(
  join(wrapDir, "package.json"),
  JSON.stringify({ dependencies: { "opencode-mem": "latest" } })
);
writeFileSync(
  join(pkgDir, "package.json"),
  JSON.stringify({ name: "opencode-mem", version: "2.26.0" })
);
assert.equal(await updateRemoveDir(pkgDir, "opencode-mem"), wrapDir);
rmSync(wrapper, { recursive: true, force: true });
console.log("✔ updateRemoveDir @latest wrapper");

const project = mkdtempSync(join(tmpdir(), "mem-au-project-"));
const projectPkg = join(project, "node_modules", "opencode-mem");
mkdirSync(projectPkg, { recursive: true });
writeFileSync(
  join(project, "package.json"),
  JSON.stringify({ dependencies: { "opencode-mem": "^2.26.0" } })
);
writeFileSync(
  join(projectPkg, "package.json"),
  JSON.stringify({ name: "opencode-mem", version: "2.26.0" })
);
assert.equal(await updateRemoveDir(projectPkg, "opencode-mem"), undefined);
const projectAlive = await checkAutoUpdate(AbortSignal.timeout(1000), {
  findPackageDir: async () => projectPkg,
  fetchLatestVersion: async () => "2.27.0",
});
assert.equal(projectAlive.updated, false);
assert.equal((await import("node:fs")).existsSync(join(project, "package.json")), true);
rmSync(project, { recursive: true, force: true });
console.log("✔ project node_modules + caret-dep is not deleted");

const missing = await checkAutoUpdate(AbortSignal.timeout(1000), {
  findPackageDir: async () => undefined,
});
assert.equal(missing.updated, false);

const updated = await checkAutoUpdate(AbortSignal.timeout(1000), {
  findPackageDir: async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-pkg-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "opencode-mem", version: "2.26.0" })
    );
    return dir;
  },
  fetchLatestVersion: async () => "2.27.0",
  updateRemoveDir: async () => "/tmp/opencode-mem@latest-fake",
  removeDir: async () => {},
});
assert.equal(updated.updated, true);
assert.equal(updated.latest, "2.27.0");
console.log("✔ checkAutoUpdate updated:true path");

const live = await checkAutoUpdate(AbortSignal.timeout(10_000));
assert.equal(typeof live.updated, "boolean");
console.log(
  live.updated
    ? `✔ live check would update ${live.current} → ${live.latest}`
    : "✔ live workspace check (no wrapper remove)"
);

const res = await fetch("https://registry.npmjs.org/opencode-mem/latest", {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(res.ok, true);
const body = await res.json();
assert.ok(typeof body.version === "string");
console.log(`✔ npm latest opencode-mem@${body.version}`);

assert.doesNotThrow(() =>
  startAutoUpdate({ client: { tui: { showToast: async () => undefined } } }, false)
);
console.log("✔ startAutoUpdate disabled no-op");

console.log("\nLIVE AUTO-UPDATE SMOKE PASSED");
