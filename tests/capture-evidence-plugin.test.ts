import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function run(scenario: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "capture-evidence-home-"));
  const child = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/capture-evidence-plugin.mjs", import.meta.url)),
      JSON.stringify(scenario),
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home } }
  );
  rmSync(home, { recursive: true, force: true });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const line = child.stdout
    .toString()
    .split("\n")
    .find((line) => line.startsWith("PLUGIN_RESULT="));
  if (!line) throw new Error(child.stdout.toString());
  return JSON.parse(line.slice("PLUGIN_RESULT=".length));
}
describe("plugin event evidence integration", () => {
  it("preserves real event-hook outputs before idle debounce and captures after host deletion", () => {
    const r = run();
    expect(r.armedCount).toBe(1);
    expect(r.savedBefore).toContain("Implemented synthetic fix; tests passed");
    expect(r.counters).toEqual({ fetch: 0, summary: 1, persist: 1 });
    expect(r.prompt.captured).toBe(true);
  });
  it("dispose retains ready rows and next plugin startup recovers without host lookup", () => {
    const r = run({ restart: true });
    expect(r.savedBefore).toContain("Implemented synthetic fix");
    expect(r.counters).toEqual({ fetch: 0, summary: 1, persist: 1 });
    expect(r.hostGetsAfterRestart).toBe(0);
    expect(r.prompt.captured).toBe(true);
  });
  it("does not persist or summarize a fully private assistant result", () => {
    const r = run({ fullyPrivate: true });
    expect(r.savedBefore).toBeNull();
    expect(r.counters.summary).toBe(0);
    expect(r.counters.persist).toBe(0);
    expect(r.prompt.captured).toBe(false);
  });
});
