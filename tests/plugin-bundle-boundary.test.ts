import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tempDirs: string[] = [];
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const bundleCache = new Map<string, string>();

function buildBundle(entrypoint: string): string {
  const cached = bundleCache.get(entrypoint);
  if (cached !== undefined) {
    return cached;
  }

  // Isolate from the test-runner resolver cache (oven-sh/bun#22941) via a fresh
  // Bun process. Prefer --outfile over stdout (stdout is the status line then).
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-bundle-"));
  tempDirs.push(dir);
  const outfile = join(dir, "bundle.js");
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      entrypoint,
      "--target=bun",
      "--packages=bundle",
      `--outfile=${outfile}`,
    ],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = Buffer.from(result.stderr).toString("utf8");
  expect(result.exitCode, stderr).toBe(0);

  const output = readFileSync(outfile, "utf8");
  expect(output.length).toBeGreaterThan(0);
  bundleCache.set(entrypoint, output);
  return output;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenCode plugin loader bundle boundary", () => {
  it("does not pull local embedding transformer internals into the plugin-loader bundle", () => {
    const output = buildBundle("./dist/plugin.js");
    expect(output).not.toContain("node_modules/@huggingface/transformers");
    expect(output).not.toContain("@huggingface/transformers/src");
    expect(output).not.toContain("@huggingface/transformers/dist");
    // Guard against the old backend silently coming back too.
    expect(output).not.toContain("node_modules/@xenova/transformers");
  }, 30_000);

  it("does not pull opencode SDK or OIDC internals into the plugin-loader bundle", () => {
    const output = buildBundle("./dist/plugin.js");
    expect(output).not.toContain("@opencode-ai/sdk/v2/client");
    expect(output).not.toContain("node_modules/@opencode-ai/sdk");
    expect(output).not.toContain("@vercel/oidc");
    expect(output).not.toContain("getVercelOidcToken");
  }, 30_000);

  it("resolves the provider module from a single-file bundled lazy loader", async () => {
    const output = buildBundle("./dist/services/ai/opencode-provider-loader.js");
    expect(output).not.toContain("@opencode-ai/sdk/v2/client");
    expect(output).not.toContain("@vercel/oidc");

    const dir = mkdtempSync(join(tmpdir(), "opencode-mem-provider-loader-"));
    tempDirs.push(dir);
    const bundlePath = join(dir, "provider-loader-bundle.mjs");
    writeFileSync(bundlePath, output);

    const mod = await import(`${pathToFileURL(bundlePath).href}?cachebust=${Date.now()}`);
    const provider = await mod.loadOpencodeProvider();

    expect(typeof provider.generateStructuredOutput).toBe("function");
    expect(typeof provider.createV2Client).toBe("function");
  }, 30_000);
});
