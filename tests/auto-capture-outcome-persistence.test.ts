import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function scenario(oversized: boolean, rewrite = false) {
  const dir = mkdtempSync(join(tmpdir(), "capture-outcome-"));
  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./fixtures/capture-outcome.mjs", import.meta.url)),
      ],
      env: {
        ...process.env,
        SOURCE: new URL("../src/", import.meta.url).href,
        STORE: dir,
        OVERSIZED: String(oversized),
        REWRITE: String(rewrite),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(Buffer.from(result.stdout).toString().trim().split("\n").at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Controlled responses validate wiring, not actual model summarization quality.
it("persists one controlled outcome from redacted v2 failure and recovery evidence", () => {
  const r = scenario(false);
  expect(r.seen).toHaveLength(1);
  expect(r.seen[0].userPrompt).toContain("FAIL auth");
  expect(r.seen[0].userPrompt).toContain("PASS auth");
  expect(r.seen[0].userPrompt).not.toContain("hidden-password");
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0].content).toContain("Deployment remains unverified");
  expect(r.prompt.captured).toBe(true);
}, 15000);
it("rejects oversized provider output without persistence or completing the prompt", () => {
  const r = scenario(true);
  expect(r.rows).toHaveLength(0);
  expect(r.prompt.captured).toBe(false);
  expect(r.prompt.capture_attempts).toBe(1);
}, 15000);

it("falls back to bounded new summary when update-on-capture returns an oversized rewrite", () => {
  const r = scenario(false, true);
  expect(r.seen).toHaveLength(2);
  expect(r.seen[1].userPrompt).toContain("Original auth finding");
  expect(r.updates).toBe(0);
  expect(r.rows).toHaveLength(2);
  expect(r.rows.find((row: any) => row.id === "existing").content).toBe("Original auth finding");
  const added = r.rows.find((row: any) => row.id !== "existing");
  expect(added.content).toContain("Deployment remains unverified");
  expect(Buffer.byteLength(added.content)).toBeLessThanOrEqual(8192);
  expect(r.prompt.captured).toBe(true);
}, 15000);
