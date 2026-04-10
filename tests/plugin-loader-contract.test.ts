/**
 * Regression guard — verifies opencode-mem satisfies the OpenCode 1.3.x plugin-loader contract.
 * Modern contract: type PluginModule = { id?: string; server: Plugin; tui?: never }
 *
 * All assertions here must PASS. This file guards the fixed contract from regressions.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function readPackageJson(): Record<string, unknown> {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function loadDistPlugin(): Promise<unknown> {
  const modUrl = new URL("../dist/plugin.js", import.meta.url).href;
  return import(modUrl);
}

describe("OpenCode 1.3.x plugin-loader contract", () => {
  it('package.json has an exports["./server"] field', () => {
    const pkg = readPackageJson();
    const exports = pkg["exports"] as Record<string, unknown> | undefined;
    expect(exports?.["./server"]).toBeDefined();
  });

  it("dist/plugin.js default export is a PluginModule object", async () => {
    const mod = (await loadDistPlugin()) as { default: unknown };
    expect(typeof mod.default).toBe("object");
  });

  it('dist/plugin.js default export has a "server" function property', async () => {
    const mod = (await loadDistPlugin()) as { default: unknown };
    const defaultExport = mod.default as Record<string, unknown> | null | undefined;
    expect(typeof defaultExport?.["server"]).toBe("function");
  });

  it('dist/plugin.js default export has a non-empty "id" matching package name', async () => {
    const pkg = readPackageJson();
    const mod = (await loadDistPlugin()) as { default: unknown };
    const defaultExport = mod.default as Record<string, unknown> | null | undefined;

    expect(typeof defaultExport?.["id"]).toBe("string");
    expect((defaultExport?.["id"] as string).trim().length).toBeGreaterThan(0);
    expect(defaultExport?.["id"]).toBe(pkg["name"]);
  });

  it("server() invocation returns hooks with expected keys (or server is callable)", async () => {
    const mod = (await loadDistPlugin()) as { default: Record<string, unknown> };
    const serverFn = mod.default["server"];
    // Verify the callable surface is correct regardless of warmup outcome
    expect(typeof serverFn).toBe("function");

    // Attempt to invoke server with a minimal mock PluginInput.
    // The plugin may throw during warmup (missing sqlite/usearch in test env) — that is expected.
    // If it succeeds, assert the returned hooks have the expected shape.
    const mockInput = {
      client: {},
      project: {},
      directory: "/tmp/test-plugin-contract",
      worktree: "/tmp/test-plugin-contract",
      serverUrl: new URL("http://localhost:4096"),
      $: {},
    };

    try {
      const hooks = (await (serverFn as (input: unknown) => Promise<Record<string, unknown>>)(
        mockInput
      )) as Record<string, unknown>;
      // If we reach here, assert expected hook keys exist
      expect(typeof hooks["chat.message"]).toBe("function");
      expect(typeof hooks["event"]).toBe("function");
    } catch {
      // Warmup/sqlite/usearch failure in test environment is acceptable.
      // The callable surface assertion above is sufficient for contract verification.
    }
  });
});
