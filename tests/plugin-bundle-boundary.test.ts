import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenCode plugin loader bundle boundary", () => {
  it("does not pull local embedding transformer internals into the plugin-loader bundle", async () => {
    const result = await Bun.build({
      entrypoints: ["./dist/plugin.js"],
      target: "bun",
      packages: "bundle",
    });

    expect(result.success).toBe(true);
    const output = await result.outputs[0]!.text();
    expect(output).not.toContain("node_modules/@huggingface/transformers");
    expect(output).not.toContain("@huggingface/transformers/src");
    expect(output).not.toContain("@huggingface/transformers/dist");
    // Guard against the old backend silently coming back too.
    expect(output).not.toContain("node_modules/@xenova/transformers");
  });

  it("does not pull opencode SDK or OIDC internals into the plugin-loader bundle", async () => {
    const result = await Bun.build({
      entrypoints: ["./dist/plugin.js"],
      target: "bun",
      packages: "bundle",
    });

    expect(result.success).toBe(true);
    const output = await result.outputs[0]!.text();
    expect(output).not.toContain("@opencode-ai/sdk/v2/client");
    expect(output).not.toContain("node_modules/@opencode-ai/sdk");
    expect(output).not.toContain("@vercel/oidc");
    expect(output).not.toContain("getVercelOidcToken");
  });

  it("resolves the provider module from a single-file bundled lazy loader", async () => {
    const result = await Bun.build({
      entrypoints: ["./dist/services/ai/opencode-provider-loader.js"],
      target: "bun",
      packages: "bundle",
    });

    expect(result.success).toBe(true);
    const output = await result.outputs[0]!.text();
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
  });
});
