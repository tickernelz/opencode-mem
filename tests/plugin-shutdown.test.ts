import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const pluginSourceUrl = new URL("../src/hosts/opencode/plugin.ts", import.meta.url);

describe("plugin shutdown", () => {
  it("does not force host process exit from signal handlers", () => {
    const source = readFileSync(pluginSourceUrl, "utf-8");

    expect(source).not.toContain("process.exit(");
  });

  it("clears pending idle auto-capture work during cleanup", () => {
    const source = readFileSync(pluginSourceUrl, "utf-8");

    // Per-session debounce timers must all be cleared on cleanup, and the
    // plugin lifetime signal must abort queued-but-unstarted capture jobs.
    expect(source).toContain("idleTimers");
    expect(source).toMatch(/for \(const timer of idleTimers\.values\(\)\) clearTimeout\(timer\)/);
    expect(source).toContain("idleTimers.clear()");
    expect(source).toContain("pluginLifetime.abort()");
    // In-flight captures must drain before storage close.
    expect(source).toContain("awaitCaptureDrain");
  });
});
