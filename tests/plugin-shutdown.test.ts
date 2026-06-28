import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("plugin shutdown", () => {
  it("does not force host process exit from signal handlers", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

    expect(source).not.toContain("process.exit(");
  });

  it("clears pending idle auto-capture work during cleanup", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

    expect(source).toContain("clearTimeout(idleTimeout)");
    expect(source).toContain("idleTimeout = null");
  });
});
