import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

function run(scenario: Record<string, unknown> = {}) {
  const child = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("./fixtures/auto-capture-session-unavailable.mjs", import.meta.url)),
    JSON.stringify(scenario),
  ]);
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return JSON.parse(child.stdout.toString());
}

describe("auto-capture missing session context", () => {
  for (const scenario of [{}, { tagged: true }, { response: true, tagged: true }]) {
    it(`defers a positively identified missing session without spending retries: ${JSON.stringify(scenario)}`, () => {
      const result = run({ ...scenario, batch: true, priorAttempts: 1 });
      expect(result.counters).toMatchObject({
        fetch: 1,
        summary: 0,
        persist: 0,
        failed: 0,
        released: 1,
        deleted: 0,
        delays: [],
      });
      expect(
        result.prompts.map((p: any) => [p.captured, p.capture_attempts, p.user_learning_captured])
      ).toEqual([
        [0, 1, 0],
        [0, 1, 0],
      ]);
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).toMatchObject({
        phase: "context",
        outcome: "skipped",
        reason: "session_not_found",
        promptId: "p0",
        sessionID: "session",
        error: "Session.NotFoundError",
      });
    });
  }
  it("does not block another session queued behind an unavailable one", () => {
    const result = run({ otherSession: true });
    expect(result.counters).toMatchObject({
      fetch: 2,
      summary: 1,
      persist: 1,
      failed: 0,
      released: 1,
      deleted: 0,
      delays: [],
    });
    expect(result.prompts.map((p: any) => p.captured)).toEqual([0, 1]);
  });

  it("retains eligibility across unavailable idles and captures once context returns", () => {
    const result = run({ recover: true, priorAttempts: 2 });
    expect(result.first.counters.failed).toBe(0);
    expect(result.counters).toMatchObject({
      fetch: 3,
      summary: 1,
      persist: 1,
      failed: 0,
      deleted: 0,
      delays: [],
    });
    expect(result.prompts[0]).toMatchObject({
      captured: 1,
      capture_attempts: 2,
      user_learning_captured: 0,
      memoryID: "memory-1",
    });
  });
  for (const kind of ["generic", "forbidden"]) {
    it(`does not classify ${kind} errors as a missing session`, () => {
      const result = run({ kind });
      expect(result.counters).toMatchObject({
        fetch: 3,
        failed: 3,
        released: 1,
        delays: [2000, 4000],
      });
      expect(result.logs.some((log: any) => log.reason === "session_not_found")).toBe(false);
    });
  }
  it("still retries transient context failures", () => {
    const result = run({ kind: "transient" });
    expect(result.counters).toMatchObject({
      fetch: 2,
      failed: 1,
      summary: 1,
      persist: 1,
      delays: [2000],
    });
    expect(result.prompts[0].captured).toBe(1);
  });
  for (const phase of ["summary", "persist"]) {
    it(`does not suppress missing-session-shaped errors from ${phase}`, () => {
      const result = run({ phase });
      expect(result.counters.failed).toBe(3);
      expect(result.counters.delays).toEqual([2000, 4000]);
      expect(result.logs.some((log: any) => log.reason === "session_not_found")).toBe(false);
    });
  }
});
