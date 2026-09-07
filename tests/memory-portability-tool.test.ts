import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const contextUrl = new URL("../src/services/context.js", import.meta.url).href;
const privacyUrl = new URL("../src/services/privacy.js", import.meta.url).href;
const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const learningUrl = new URL("../src/services/user-memory-learning.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const webServerUrl = new URL("../src/services/web-server.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;

function runTool(args: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-portability-tool-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const calls = {
  ensureStorageReady: 0,
  warmup: 0,
  listShards: 0,
  migrate: null,
  export: null,
  import: null,
};
let counting = false;

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => { if (counting) calls.warmup += 1; },
    ensureStorageReady: async () => { if (counting) calls.ensureStorageReady += 1; },
    getEmbeddingInitError: () => null,
    listShards: async () => {
      calls.listShards += 1;
      return { success: true, shards: [], summary: { total: 0 } };
    },
    migrateProjectPath: async (opts) => {
      calls.migrate = opts;
      return { success: true, dryRun: Boolean(opts.dryRun), migratedMemories: 0 };
    },
    exportMemories: async (directory, outputPath) => {
      calls.export = { directory, outputPath };
      return { success: true, outputPath, count: 0 };
    },
    importMemories: async (directory, inputPath, dryRun) => {
      calls.import = { directory, inputPath, dryRun };
      return { success: true, dryRun: Boolean(dryRun), imported: 0 };
    },
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: { autoCaptureLanguage: "en", memory: { defaultScope: "project" } },
  initConfig: () => {},
  isConfigured: () => true,
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({ project: { tag: "project-tag" }, user: { userEmail: "u@example.com" } }),
}));
mock.module(${JSON.stringify(contextUrl)}, () => ({ formatContextForPrompt: () => "" }));
mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (value) => value,
  isFullyPrivate: () => false,
}));
mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({ performAutoCapture: async () => {} }));
mock.module(${JSON.stringify(learningUrl)}, () => ({ performUserProfileLearning: async () => {} }));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({ userPromptManager: { savePrompt() {} } }));
mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({ directory: "/workspace", client: {} });
const memoryTool = plugin.tool?.memory;
if (!memoryTool) throw new Error("memory tool not available");
// Ignore fire-and-forget plugin-init warmup; count only tool.execute traffic.
await new Promise((resolve) => setTimeout(resolve, 20));
counting = true;
const result = JSON.parse(await memoryTool.execute(${JSON.stringify(args)}, { sessionID: "s1" }));
console.log(JSON.stringify({ result, calls }));
`;
  writeFileSync(scriptPath, script);
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || "tool scenario failed");
  }
  return JSON.parse(result.stdout.toString());
}

describe("memory portability tool modes", () => {
  it("lists migrate/export/import in help", () => {
    const { result } = runTool({ mode: "help" });
    expect(result.success).toBe(true);
    const commands = result.commands.map((command: { command: string }) => command.command);
    expect(commands).toContain("migrate");
    expect(commands).toContain("list-shards");
    expect(commands).toContain("export");
    expect(commands).toContain("import");
  });

  it("requires fromPath or fromHash for migrate and skips embedding warmup", () => {
    const missing = runTool({ mode: "migrate" });
    expect(missing.result.success).toBe(false);
    expect(missing.result.error).toContain("fromPath or fromHash");
    expect(missing.calls.warmup).toBe(0);
    expect(missing.calls.ensureStorageReady).toBe(1);

    const ok = runTool({ mode: "migrate", fromHash: "0123456789abcdef", dryRun: true });
    expect(ok.result.success).toBe(true);
    expect(ok.calls.migrate).toEqual({
      currentDirectory: "/workspace",
      fromPath: undefined,
      fromHash: "0123456789abcdef",
      dryRun: true,
      allowLinkedSource: undefined,
    });
    expect(ok.calls.warmup).toBe(0);
  });

  it("requires outputPath/inputPath and warms embeddings only for import", () => {
    const exportMissing = runTool({ mode: "export" });
    expect(exportMissing.result.success).toBe(false);
    expect(exportMissing.calls.warmup).toBe(0);

    const exportOk = runTool({ mode: "export", outputPath: "/tmp/out.json" });
    expect(exportOk.result.success).toBe(true);
    expect(exportOk.calls.export.outputPath).toBe("/tmp/out.json");
    expect(exportOk.calls.warmup).toBe(0);

    const importMissing = runTool({ mode: "import" });
    expect(importMissing.result.success).toBe(false);

    const importOk = runTool({ mode: "import", inputPath: "/tmp/in.json", dryRun: true });
    expect(importOk.result.success).toBe(true);
    expect(importOk.calls.warmup).toBe(1);
    expect(importOk.calls.import).toEqual({
      directory: "/workspace",
      inputPath: "/tmp/in.json",
      dryRun: true,
    });
  }, 15000);

  it("list-shards uses storage ready without embedding warmup", () => {
    const listed = runTool({ mode: "list-shards" });
    expect(listed.result.success).toBe(true);
    expect(listed.calls.listShards).toBe(1);
    expect(listed.calls.warmup).toBe(0);
    expect(listed.calls.ensureStorageReady).toBe(1);
  });
});
