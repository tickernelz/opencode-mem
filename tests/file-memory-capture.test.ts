import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function scenario(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), "file-memory-capture-"));
  try {
    const child = Bun.spawnSync([
      process.execPath,
      fileURLToPath(new URL("./fixtures/file-memory-capture.mjs", import.meta.url)),
      directory,
      mode,
    ]);
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString().trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("observed file associations during capture", () => {
  it("binds only named successful observed files from the exact authored turn", () => {
    const result = scenario("queued");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].metadata.observedFiles.paths).toEqual(["src/auth.ts"]);
    expect(result.rows[1].metadata.observedFiles.paths).toEqual(["src/other.ts"]);
    expect(result.matches).toEqual([true, true]);
    expect(result.providerCalls).toBe(2);
  });
  it("keeps the full ordinary memory when the summary names no observed file", () => {
    const result = scenario("unnamed");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].content).toBe(
      "The helper requires a cookie before checking permissions."
    );
    expect(result.rows[0].metadata.observedFiles).toBeNull();
    expect(result.matches).toEqual([false]);
    expect(result.providerCalls).toBe(1);
  });
  for (const mode of ["disabled", "markdown", "workspace", "replay", "fallback"]) {
    it(`retains ordinary capture without inventing associations in ${mode} mode`, () => {
      const result = scenario(mode);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].metadata.observedFiles).toBeUndefined();
      expect(result.providerCalls).toBe(1);
      if (mode === "replay") expect(result.hostReads).toBe(0);
    });
  }
});
