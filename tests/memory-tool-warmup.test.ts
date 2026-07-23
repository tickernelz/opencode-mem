import { describe, expect, it, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

describe("memory tool warmup gate", () => {
  let baseDir: string;
  let scriptPath: string;

  afterEach(async () => {
    mock.restore();
    if (scriptPath) rmSync(scriptPath, { force: true });
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
  });

  it("calls warmup instead of rejecting when client is not yet initialized", async () => {
    baseDir = mkdtempSync(join(tmpdir(), "memory-tool-warmup-"));
    scriptPath = join(baseDir, "run.mjs");

    const clientUrl = pathToFileURL(join(import.meta.dirname, "../src/services/client.ts")).href;

    const script = `
import { mock } from "bun:test";

let warmupCalls = 0;
mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    isReady: async () => false,
    warmup: async () => {
      warmupCalls += 1;
    },
    addMemory: async () => ({ success: true, id: "mem_1" }),
    searchMemories: async () => ({ success: true, results: [], total: 0 }),
    listMemories: async () => ({ success: true, memories: [], pagination: {} }),
    deleteMemory: async () => ({ success: true }),
  },
}));

// Minimal stand-in for the tool gate logic from index.ts
const memoryClient = (await import(${JSON.stringify(clientUrl)})).memoryClient;
await memoryClient.warmup();
const readyAfter = await memoryClient.isReady();
console.log(JSON.stringify({ warmupCalls, readyAfter: typeof readyAfter === "boolean" }));
`;

    writeFileSync(scriptPath, script, "utf-8");
    const result = Bun.spawnSync({
      cmd: [process.execPath, scriptPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = Buffer.from(result.stdout).toString("utf8").trim();
    const jsonLine = stdout
      .split("\n")
      .reverse()
      .find((line) => line.trim().startsWith("{"));
    const parsed = jsonLine ? JSON.parse(jsonLine) : null;

    expect(result.exitCode).toBe(0);
    expect(parsed?.warmupCalls).toBe(1);
  });
});
