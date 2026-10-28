import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tempDirs: string[] = [];
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function buildBundle(entrypoint: string): string {
  // Keep bundling outside the test runner's resolver cache (oven-sh/bun#22941).
  // Use the current Bun executable and retain package bundling for these guards.
  const result = Bun.spawnSync(
    [process.execPath, "build", entrypoint, "--target=bun", "--packages=bundle"],
    { cwd: projectRoot }
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
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
