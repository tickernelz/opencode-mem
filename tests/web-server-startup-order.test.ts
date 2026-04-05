import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("web server startup order", () => {
  it("starts the web server before background warmup and avoids blocking warmup", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

    expect(source.includes("await memoryClient.warmup()")).toBe(true);
    expect(
      source.includes(
        "await memoryClient.warmup();\n        globalState[GLOBAL_PLUGIN_WARMUP_KEY] = true;"
      )
    ).toBe(true);
    expect(
      source.includes(
        "await memoryClient.warmup();\n      (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;"
      )
    ).toBe(false);
    expect(source.includes("startBackgroundWarmup();")).toBe(true);

    const webServerIndex = source.indexOf("startWebServer({");
    const warmupIndex = source.indexOf("startBackgroundWarmup();");
    expect(webServerIndex).toBeGreaterThan(-1);
    expect(warmupIndex).toBeGreaterThan(-1);
    expect(webServerIndex).toBeLessThan(warmupIndex);
  });

  it("retries background warmup when memory tool is still initializing", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

    const toolGuard = source.indexOf("const needsWarmup = !(await memoryClient.isReady());");
    const retryCall = source.indexOf("startBackgroundWarmup();", toolGuard);

    expect(toolGuard).toBeGreaterThan(-1);
    expect(retryCall).toBeGreaterThan(toolGuard);
  });
});
