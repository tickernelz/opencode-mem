import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTextFromPromptResult } from "../src/services/user-profile/ai-cleanup.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("extractTextFromPromptResult", () => {
  it("reads text from data.parts (SDK wrapped shape)", () => {
    const { info, rawText } = extractTextFromPromptResult({
      data: {
        info: {},
        parts: [
          { type: "text", text: '{"mapping":{"kept":["pref_0"],"merged":[],"removed":[]}}' },
          { type: "step-finish" },
        ],
      },
    });

    expect(info).toEqual({});
    expect(rawText).toContain('"kept":["pref_0"]');
  });

  it("reads text from top-level parts when data wrapper is absent", () => {
    const { info, rawText } = extractTextFromPromptResult({
      info: {},
      parts: [{ type: "text", text: '{"ok":true}' }],
    });

    expect(info).toEqual({});
    expect(rawText).toBe('{"ok":true}');
  });

  it("does not use nonexistent info.text", () => {
    const { rawText } = extractTextFromPromptResult({
      data: {
        info: { text: '{"fromInfo":true}' },
        parts: [],
      },
    });

    expect(rawText).toBe("");
  });

  it("surfaces assistant errors from info", () => {
    const { info, rawText } = extractTextFromPromptResult({
      data: {
        info: { error: { name: "ApiError", data: { message: "boom" } } },
        parts: [],
      },
    });

    expect(info?.error?.name).toBe("ApiError");
    expect(rawText).toBe("");
  });
});

const aiCleanupUrl = new URL("../src/services/user-profile/ai-cleanup.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;

function runCleanupScenario(opts: {
  promptThrows?: boolean;
  clientAvailable?: boolean;
  withExternalApi?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-ai-cleanup-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const promptThrows = opts.promptThrows ?? false;
  const clientAvailable = opts.clientAvailable ?? true;
  const withExternalApi = opts.withExternalApi ?? false;

  const script = `
import { mock } from "bun:test";

const promptCalls = [];
const deleteCalls = [];
let externalFetchCalled = false;
let externalRequestBody = null;

const cleanupJson = JSON.stringify({
  preferences: [{ id: "pref_0", category: "style", description: "Prefer concise answers" }],
  patterns: [],
  workflows: [],
  mapping: {
    kept: ["pref_0"],
    merged: [],
    removed: ["pref_1"],
  },
});

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    opencodeProvider: "openai",
    opencodeModel: "gpt-test",
    memoryModel: ${withExternalApi ? '"gpt-ext"' : "undefined"},
    memoryApiUrl: ${withExternalApi ? '"http://example.test/v1"' : "undefined"},
    memoryApiKey: "test-key",
    memoryExtraParams: {
      enable_thinking: false,
      top_p: 0.7,
      model: "must-not-override",
      messages: [{ role: "user", content: "must-not-override" }],
      temperature: 0.9,
      response_format: { type: "text" },
    },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    getV2Client: () =>
      ${clientAvailable}
        ? {
            session: {
              create: async () => ({ data: { id: "sess-cleanup-1" } }),
              prompt: async (args) => {
                promptCalls.push(args);
                if (${promptThrows}) {
                  throw new Error("prompt failed for test");
                }
                return {
                  data: {
                    info: {},
                    parts: [{ type: "text", text: cleanupJson }],
                  },
                };
              },
              delete: async (args) => {
                deleteCalls.push(args);
              },
            },
          }
        : null,
  }),
}));

if (${withExternalApi}) {
  globalThis.fetch = async (_url, init) => {
    externalFetchCalled = true;
    externalRequestBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: cleanupJson } }],
      }),
    };
  };
}

const { aiCleanupProfile } = await import(${JSON.stringify(aiCleanupUrl)});

const profile = {
  preferences: [
    { category: "style", description: "Prefer concise answers", confidence: 0.9, frequency: 2 },
    { category: "style", description: "likes short replies", confidence: 0.5, frequency: 1 },
  ],
  patterns: [],
  workflows: [],
};

let errorMessage = null;
let result = null;
try {
  result = await aiCleanupProfile(profile);
} catch (e) {
  errorMessage = String(e?.message || e);
}

console.log(
  JSON.stringify({
    errorMessage,
    promptCalls,
    deleteCalls,
    externalFetchCalled,
    externalRequestBody,
    kept: result?.diff?.kept ?? null,
    removed: result?.diff?.removed?.map((r) => r.id) ?? null,
    noReply: promptCalls[0]?.noReply,
  })
);
`;

  writeFileSync(scriptPath, script);

  const spawned = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(spawned.stdout).toString("utf8").trim();
  const stderr = Buffer.from(spawned.stderr).toString("utf8").trim();

  return {
    exitCode: spawned.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("AI cleanup opencode provider path (#177)", () => {
  it("succeeds with noReply false and text parts", () => {
    const result = runCleanupScenario({});

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.errorMessage).toBeNull();
    expect(result.parsed?.noReply).toBe(false);
    expect(result.parsed?.promptCalls).toHaveLength(1);
    expect(result.parsed?.deleteCalls).toEqual([{ sessionID: "sess-cleanup-1" }]);
    expect(result.parsed?.kept).toEqual(["Prefer concise answers"]);
    expect(result.parsed?.removed).toEqual(["pref_1"]);
    expect(result.parsed?.externalFetchCalled).toBe(false);
  });

  it("surfaces opencode errors instead of masking as missing provider", () => {
    const result = runCleanupScenario({ promptThrows: true, withExternalApi: false });

    expect(result.exitCode).toBe(0);
    expect(result.parsed?.errorMessage).toContain("prompt failed for test");
    expect(result.parsed?.errorMessage).not.toContain("No AI provider configured");
    expect(result.parsed?.externalFetchCalled).toBe(false);
  });

  it("does not fall back to external API when opencode client is available and fails", () => {
    const result = runCleanupScenario({ promptThrows: true, withExternalApi: true });

    expect(result.exitCode).toBe(0);
    expect(result.parsed?.errorMessage).toContain("prompt failed for test");
    expect(result.parsed?.externalFetchCalled).toBe(false);
  });

  it("falls back to external API when opencode client is unavailable", () => {
    const result = runCleanupScenario({ clientAvailable: false, withExternalApi: true });

    expect(result.exitCode).toBe(0);
    expect(result.parsed?.errorMessage).toBeNull();
    expect(result.parsed?.externalFetchCalled).toBe(true);
    expect(result.parsed?.kept).toEqual(["Prefer concise answers"]);
    expect(result.parsed?.externalRequestBody).toMatchObject({
      model: "gpt-ext",
      temperature: 0.3,
      response_format: { type: "json_object" },
      enable_thinking: false,
      top_p: 0.7,
    });
    expect(result.parsed?.externalRequestBody?.messages).toHaveLength(2);
  });
});
