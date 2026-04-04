import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { logDebug } from "../src/services/logger.js";

const LOG_FILE = join(tmpdir(), `opencode-mem-debug-test-${process.pid}.log`);

describe("logDebug", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env["OPENCODE_MEM_LOG_FILE"];
    process.env["OPENCODE_MEM_LOG_FILE"] = LOG_FILE;
  });

  afterEach(async () => {
    if (prevEnv === undefined) {
      delete process.env["OPENCODE_MEM_LOG_FILE"];
    } else {
      process.env["OPENCODE_MEM_LOG_FILE"] = prevEnv;
    }
    try {
      await rm(LOG_FILE, { force: true });
    } catch {}
  });

  it("should write [DEBUG] entry when enabled is true", async () => {
    logDebug(true, "test-enabled", { x: 1 });
    const content = await readFile(LOG_FILE, "utf-8");
    expect(content).toContain("[DEBUG] test-enabled");
    expect(content).toContain('"x":1');
  });

  it("should be a no-op and return undefined when enabled is false", () => {
    const result = logDebug(false, "should-not-appear");
    expect(result).toBeUndefined();
  });

  it("should prefix emitted log line with [DEBUG]", async () => {
    logDebug(true, "prefix-check");
    const content = await readFile(LOG_FILE, "utf-8");
    expect(content).toMatch(/\[DEBUG\] prefix-check/);
  });

  it("should include data payload in [DEBUG] entry", async () => {
    logDebug(true, "payload-test", { count: 42, mode: "hybrid" });
    const content = await readFile(LOG_FILE, "utf-8");
    expect(content).toContain("[DEBUG] payload-test");
    expect(content).toContain('"count":42');
    expect(content).toContain('"mode":"hybrid"');
  });

  it("should write multiple [DEBUG] entries when called multiple times with enabled=true", async () => {
    logDebug(true, "entry-one");
    logDebug(true, "entry-two");
    const content = await readFile(LOG_FILE, "utf-8");
    expect(content).toContain("[DEBUG] entry-one");
    expect(content).toContain("[DEBUG] entry-two");
  });
});
