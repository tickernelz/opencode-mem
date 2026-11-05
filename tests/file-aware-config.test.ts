import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "file-aware-config-"));
let result: Record<string, boolean>;
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeAll(() => {
  const child = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("./fixtures/file-aware-config.mjs", import.meta.url)),
    directory,
  ]);
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  result = JSON.parse(child.stdout.toString().trim());
});

describe("file-aware recall configuration", () => {
  it("enables file-aware recall when the setting is missing or true", () => {
    for (const name of ["initial", "omitted", "missingFlag", "enabled"])
      expect(result[name]).toBe(true);
  });

  it("requires boolean false to opt out and defaults invalid values to enabled", () => {
    expect(result.disabled).toBe(false);
    for (const value of [null, "false", "true", 0, 1, [], {}])
      expect(result[`invalid:${JSON.stringify(value)}`]).toBe(true);
  });

  it("preserves a global opt-out through unrelated project settings and allows explicit overrides", () => {
    expect(result.globalOptOutWithUnrelatedProject).toBe(false);
    expect(result.explicitProjectOptIn).toBe(true);
    expect(result.explicitProjectOptOut).toBe(false);
    expect(result.invalidProjectValue).toBe(false);
    for (const value of [null, "false", "true", 0, 1, [], {}])
      expect(result[`invalid-project:${JSON.stringify(value)}`]).toBe(false);
  });

  it("leaves the other opt-in memory features disabled", () => {
    expect(result.updateOnCaptureEnabled).toBe(false);
    expect(result.dreamingEnabled).toBe(false);
  });
});
