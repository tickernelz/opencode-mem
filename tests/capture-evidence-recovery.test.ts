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
      fileURLToPath(new URL("./fixtures/capture-evidence-recovery.mjs", import.meta.url)),
      JSON.stringify(scenario),
    ],
    { env: { ...process.env, HOME: home, USERPROFILE: home } }
  );
  rmSync(home, { recursive: true, force: true });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const line = child.stdout
    .toString()
    .split("\n")
    .find((line) => line.startsWith("EVIDENCE_RESULT="));
  if (!line) throw new Error(child.stdout.toString());
  return JSON.parse(line.slice("EVIDENCE_RESULT=".length));
}
describe("deleted-session durable evidence recovery", () => {
  for (const v1 of [false, true]) {
    it(`captures final ${v1 ? "V1" : "V2"} observations after host deletion without fetching the transcript`, () => {
      const r = run({ v1 });
      expect(r.counters).toEqual({ fetch: 0, summary: 1, persist: 1 });
      expect(r.evidence).toContain("Changed synthetic implementation and verified tests");
      expect(r.evidence).toContain("3 synthetic tests passed");
      expect(r.summaryInputs[0]).toContain("observed outcomes");
      expect(r.prompt.captured).toBe(true);
      expect(r.afterEvidence).toBeNull();
    });
    it(`redacts private regions spanning ${v1 ? "V1" : "V2"} final text parts before capture`, () => {
      const r = run({ v1, privateParts: true });
      expect(r.evidence).toContain("Visible fix");
      expect(r.evidence).toContain("verified tests");
      expect(r.evidence).not.toContain("SECRET_A");
      expect(r.evidence).not.toContain("SECRET_B");
      expect(r.summaryInputs.join("\n")).not.toContain("SECRET_");
    });
  }
  it("keeps a queued next prompt from stealing the preceding response", () => {
    const r = run({ queuedNext: true });
    expect(r.prompt.captured).toBe(true);
    expect(r.queuedPrompt.captured).toBe(false);
    expect(r.queuedEvidence).toBeNull();
    expect(r.counters.summary).toBe(1);
    expect(r.counters.persist).toBe(1);
  });
  it("does not let an older unavailable request starve newer saved evidence in the same session", () => {
    const r = run({ olderPending: true, queuedNext: true });
    expect(r.olderPrompt.captured).toBe(false);
    expect(r.olderPrompt.capture_attempts).toBe(0);
    expect(r.prompt.captured).toBe(true);
    expect(r.queuedPrompt.captured).toBe(false);
    expect(r.queuedPrompt.capture_attempts).toBe(0);
    expect(r.counters).toEqual({ fetch: 1, summary: 1, persist: 1 });
    expect(r.afterEvidence).toBeNull();
    expect(r.evidence.match(/Changed synthetic implementation/g)).toHaveLength(1);
  });
  it("recovers ready evidence across closed connections/new manager and recorder", () => {
    const r = run({ restart: true });
    expect(r.restoredSessions).toEqual(["s"]);
    expect(r.counters).toEqual({ fetch: 0, summary: 1, persist: 1 });
  });
  it("deduplicates final events and repeat capture", () => {
    const r = run({ duplicate: true });
    expect(r.evidence.match(/Changed synthetic implementation/g)).toHaveLength(1);
    expect(r.counters).toEqual({ fetch: 0, summary: 1, persist: 1 });
  });
  it("uses deletion as a checkpoint for already observed evidence", () => {
    expect(run({ deletedCheckpoint: true }).counters).toEqual({ fetch: 0, summary: 1, persist: 1 });
  });
  for (const scenario of [{ otherProject: true }, { unknownInbox: true }, { noEvidence: true }]) {
    it(`never guesses missing evidence or prompt ownership: ${JSON.stringify(scenario)}`, () => {
      const r = run(scenario);
      expect(r.evidence).toBeNull();
      expect(r.counters.summary).toBe(0);
      expect(r.counters.persist).toBe(0);
      expect(r.prompt.captured).toBe(false);
      expect(r.prompt.capture_attempts).toBe(0);
      if ("otherProject" in scenario) expect(r.counters.fetch).toBe(0);
      else expect(r.logs.some((l: any) => l.reason === "session_not_found")).toBe(true);
    });
  }
});
