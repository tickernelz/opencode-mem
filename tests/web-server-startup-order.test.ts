import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("web server startup order", () => {
  it("starts the web server before background warmup and avoids blocking warmup", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(
      /\r\n/g,
      "\n"
    );

    expect(source).toMatch(/memoryClient\.warmup\(\)/);
    expect(source).toMatch(/Promise\.race\(\[\s*memoryClient\.warmup\(\)/s);
    expect(source).toMatch(/GLOBAL_PLUGIN_WARMUP_TIMEOUT_MS/);
    expect(source).toMatch(
      /globalState\[GLOBAL_PLUGIN_WARMUP_PROMISE_KEY\] === warmupState\.promise/
    );
    expect(source).toMatch(/startBackgroundWarmup\(\);/);

    const webServerIndex = source.indexOf("startWebServer({");
    const warmupIndex = source.indexOf("startBackgroundWarmup();");
    expect(webServerIndex).toBeGreaterThan(-1);
    expect(warmupIndex).toBeGreaterThan(-1);
    expect(webServerIndex).toBeLessThan(warmupIndex);
  });

  it("retries background warmup when memory tool is still initializing", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8").replace(
      /\r\n/g,
      "\n"
    );

    const toolGuard = source.indexOf("const needsWarmup = !(await memoryClient.isReady());");
    const retryCall = source.indexOf("startBackgroundWarmup();", toolGuard);

    expect(toolGuard).toBeGreaterThan(-1);
    expect(retryCall).toBeGreaterThan(toolGuard);
  });
});
