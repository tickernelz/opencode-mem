import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { buildMemoryProviderConfig } from "../src/services/ai/provider-config.js";
import { applySafeExtraParams } from "../src/services/ai/providers/base-provider.js";
import {
  initConfig,
  CONFIG,
  normalizeOpencodeTimeoutMs,
  outerStructuredOutputTimeoutMs,
  OPENCODE_TIMEOUT_MS_DEFAULT,
} from "../src/config.js";

describe("project-scoped config resolution", () => {
  let readSpy: ReturnType<typeof spyOn>;
  let existsSpy: ReturnType<typeof spyOn>;

  const normalizePath = (p: unknown) => String(p).replace(/\\/g, "/");

  afterEach(() => {
    readSpy?.mockRestore();
    existsSpy?.mockRestore();
    // Reset to global-only config
    initConfig("/nonexistent-project");
  });

  it("uses global config when no project config exists", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p) => {
      const path = normalizePath(p);
      return path.includes(".config/opencode/opencode-mem");
    });
    readSpy = spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ opencodeModel: "global-model" })
    );
    initConfig("/some/project");
    expect(CONFIG.opencodeModel).toBe("global-model");
  });

  it("project config overrides global config", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({
          opencodeProvider: "openai",
          opencodeModel: "project-model",
        }) as any;
      }
      return JSON.stringify({
        opencodeProvider: "anthropic",
        opencodeModel: "global-model",
      }) as any;
    });
    initConfig("/my/project");
    expect(CONFIG.opencodeProvider).toBe("openai");
    expect(CONFIG.opencodeModel).toBe("project-model");
  });

  it("preserves JSONC string values through configuration loading and provider parameters", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p: unknown) =>
      normalizePath(p).includes(".config/opencode/opencode-mem")
    );
    readSpy = spyOn(fs, "readFileSync").mockReturnValue(`{
      "storagePath": "/tmp/cache,]v2",
      "memoryModel": "local-model",
      "memoryApiUrl": "https://example.invalid/v1",
      "memoryApiKey": "fixture-only-key",
      "memoryExtraParams": {"stop": [",}", ",]",],},
    }`);

    initConfig("/some/project");

    expect(CONFIG.storagePath).toBe("/tmp/cache,]v2");
    expect(CONFIG.memoryExtraParams).toEqual({ stop: [",}", ",]"] });
    const providerConfig = buildMemoryProviderConfig(CONFIG);
    const requestBody: Record<string, unknown> = {};
    applySafeExtraParams(requestBody, providerConfig.extraParams ?? {});
    expect(requestBody.stop).toEqual([",}", ",]"]);
  });

  it("keeps automatic cleanup policy under global configuration", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({
          opencodeModel: "project-model",
          autoCleanupEnabled: true,
          autoCleanupRetentionDays: 0,
        }) as any;
      }
      return JSON.stringify({
        opencodeModel: "global-model",
        autoCleanupEnabled: false,
        autoCleanupRetentionDays: 90,
      }) as any;
    });

    initConfig("/my/project");

    expect(CONFIG.opencodeModel).toBe("project-model");
    expect(CONFIG.autoCleanupEnabled).toBe(false);
    expect(CONFIG.autoCleanupRetentionDays).toBe(90);
  });

  it("uses safe cleanup defaults when only project cleanup settings exist", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p) =>
      normalizePath(p).includes("/my/project/.opencode/opencode-mem")
    );
    readSpy = spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        autoCleanupEnabled: true,
        autoCleanupRetentionDays: -1,
      })
    );

    initConfig("/my/project");

    expect(CONFIG.autoCleanupEnabled).toBe(true);
    expect(CONFIG.autoCleanupRetentionDays).toBe(30);
  });

  it("rejects project embedding transport settings before they can inherit secrets", () => {
    const oldOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-secret";
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({
          embeddingApiUrl: "https://attacker.example/v1",
        }) as any;
      }
      return JSON.stringify({ embeddingModel: "global-model" }) as any;
    });

    try {
      expect(() => initConfig("/my/project")).toThrow(
        "Project config cannot set remote provider fields: embeddingApiUrl"
      );
    } finally {
      if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAiKey;
    }
  });

  it("rejects project memory provider settings before they can reuse a global key", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({
          memoryProvider: "orcarouter",
          memoryApiUrl: "https://attacker.example/v1",
        }) as any;
      }
      return JSON.stringify({ memoryApiKey: "global-secret" }) as any;
    });

    expect(() => initConfig("/my/project")).toThrow(
      "Project config cannot set remote provider fields: memoryProvider, memoryApiUrl"
    );
  });

  it("keeps global remote providers and ordinary project overrides working", () => {
    const oldEmbeddingKey = process.env.TEST_EMBEDDING_KEY;
    const oldMemoryKey = process.env.TEST_MEMORY_KEY;
    process.env.TEST_EMBEDDING_KEY = "global-embedding-secret";
    process.env.TEST_MEMORY_KEY = "global-memory-secret";
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({ opencodeModel: "project-model" }) as any;
      }
      return JSON.stringify({
        embeddingApiUrl: "https://trusted-embeddings.example/v1",
        embeddingApiKey: "env://TEST_EMBEDDING_KEY",
        memoryProvider: "openai-chat",
        memoryApiUrl: "https://trusted-memory.example/v1",
        memoryApiKey: "env://TEST_MEMORY_KEY",
      }) as any;
    });

    try {
      initConfig("/my/project");
      expect(CONFIG.opencodeModel).toBe("project-model");
      expect(CONFIG.embeddingApiUrl).toBe("https://trusted-embeddings.example/v1");
      expect(CONFIG.embeddingApiKey).toBe("global-embedding-secret");
      expect(CONFIG.memoryProvider).toBe("openai-chat");
      expect(CONFIG.memoryApiUrl).toBe("https://trusted-memory.example/v1");
      expect(CONFIG.memoryApiKey).toBe("global-memory-secret");
    } finally {
      if (oldEmbeddingKey === undefined) delete process.env.TEST_EMBEDDING_KEY;
      else process.env.TEST_EMBEDDING_KEY = oldEmbeddingKey;
      if (oldMemoryKey === undefined) delete process.env.TEST_MEMORY_KEY;
      else process.env.TEST_MEMORY_KEY = oldMemoryKey;
    }
  });

  it("shallow merge: project adds fields, global fields preserved when not overridden", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({ opencodeProvider: "anthropic" }) as any;
      }
      return JSON.stringify({ opencodeModel: "claude-haiku", autoCaptureEnabled: false }) as any;
    });
    initConfig("/my/project");
    expect(CONFIG.opencodeProvider).toBe("anthropic");
    expect(CONFIG.opencodeModel).toBe("claude-haiku");
    expect(CONFIG.autoCaptureEnabled).toBe(false);
  });

  it("parses opencodeVariant when set and treats blank values as unset", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p) =>
      normalizePath(p).includes(".config/opencode/opencode-mem")
    );
    readSpy = spyOn(fs, "readFileSync");

    readSpy.mockReturnValue(
      JSON.stringify({
        opencodeProvider: "newapi",
        opencodeModel: "grok-4.7",
        opencodeVariant: "xhigh",
      }) as any
    );
    initConfig("/some/project");
    expect(CONFIG.opencodeVariant).toBe("xhigh");

    readSpy.mockReturnValue(
      JSON.stringify({
        opencodeProvider: "newapi",
        opencodeModel: "grok-4.7",
        opencodeVariant: "   ",
      }) as any
    );
    initConfig("/some/project");
    expect(CONFIG.opencodeVariant).toBeUndefined();

    readSpy.mockReturnValue(
      JSON.stringify({
        opencodeProvider: "newapi",
        opencodeModel: "grok-4.7",
      }) as any
    );
    initConfig("/some/project");
    expect(CONFIG.opencodeVariant).toBeUndefined();
  });

  it("parses opencodeTimeoutMs with clamping and default fallback", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p) =>
      normalizePath(p).includes(".config/opencode/opencode-mem")
    );
    readSpy = spyOn(fs, "readFileSync");

    readSpy.mockReturnValue(JSON.stringify({ opencodeTimeoutMs: 180000 }) as any);
    initConfig("/some/project");
    expect(CONFIG.opencodeTimeoutMs).toBe(180000);

    // Below the floor.
    readSpy.mockReturnValue(JSON.stringify({ opencodeTimeoutMs: 500 }) as any);
    initConfig("/some/project");
    expect(CONFIG.opencodeTimeoutMs).toBe(10000);

    // Above the ceiling.
    readSpy.mockReturnValue(JSON.stringify({ opencodeTimeoutMs: 9_999_999 }) as any);
    initConfig("/some/project");
    expect(CONFIG.opencodeTimeoutMs).toBe(600000);

    // Non-finite values fall back to the default.
    readSpy.mockReturnValue(JSON.stringify({ opencodeTimeoutMs: Number.POSITIVE_INFINITY }) as any);
    initConfig("/some/project");
    expect(CONFIG.opencodeTimeoutMs).toBe(90000);

    // Numeric strings are coerced (common in hand-edited JSONC).
    readSpy.mockReturnValue(JSON.stringify({ opencodeTimeoutMs: "180000" }) as any);
    initConfig("/some/project");
    expect(CONFIG.opencodeTimeoutMs).toBe(180000);

    // Unset keeps the default.
    readSpy.mockReturnValue(JSON.stringify({}) as any);
    initConfig("/some/project");
    expect(CONFIG.opencodeTimeoutMs).toBe(90000);
  });

  it("parses chatMessage.captureChildSessions from the global config", () => {
    existsSpy = spyOn(fs, "existsSync").mockImplementation((p) =>
      normalizePath(p).includes(".config/opencode/opencode-mem")
    );
    readSpy = spyOn(fs, "readFileSync");

    readSpy.mockReturnValue(
      JSON.stringify({
        chatMessage: { captureChildSessions: true },
      }) as any
    );
    initConfig("/some/project");
    expect(CONFIG.chatMessage.captureChildSessions).toBe(true);

    readSpy.mockReturnValue(JSON.stringify({ chatMessage: {} }) as any);
    initConfig("/some/project");
    expect(CONFIG.chatMessage.captureChildSessions).toBe(false);
  });

  it("falls back to defaults when neither global nor project config exists", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
    initConfig("/no/config/project");
    expect(CONFIG.autoCaptureEnabled).toBe(true); // default value
    expect(CONFIG.opencodeProvider).toBeUndefined();
  });

  it("resolves Atlas Cloud API key from ATLASCLOUD_API_KEY and marks manual ready", () => {
    const originalApiKey = process.env.ATLASCLOUD_API_KEY;
    process.env.ATLASCLOUD_API_KEY = "atlas-test-key";

    try {
      existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
      readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
        const path = normalizePath(p);
        if (path.includes(".opencode/opencode-mem")) {
          return JSON.stringify({ autoCaptureEnabled: true }) as any;
        }
        return JSON.stringify({ memoryProvider: "atlas-cloud" }) as any;
      });

      initConfig("/my/project");

      expect(CONFIG.memoryProvider).toBe("atlas-cloud");
      expect(CONFIG.memoryModel).toBeUndefined();
      expect(CONFIG.memoryApiUrl).toBeUndefined();
      expect(CONFIG.memoryApiKey).toBe("atlas-test-key");
      expect(CONFIG.autoCaptureProviderStatus).toEqual({
        ready: true,
        mode: "manual",
        issues: [],
      });
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.ATLASCLOUD_API_KEY;
      } else {
        process.env.ATLASCLOUD_API_KEY = originalApiKey;
      }
    }
  });

  it("refuses a project config that switches memoryProvider to Atlas Cloud", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(true);
    readSpy = spyOn(fs, "readFileSync").mockImplementation((p) => {
      const path = normalizePath(p);
      if (path.includes(".opencode/opencode-mem")) {
        return JSON.stringify({ memoryProvider: "atlas-cloud" }) as any;
      }
      return JSON.stringify({
        memoryProvider: "openai-chat",
        memoryModel: "gpt-global",
        memoryApiUrl: "https://api.openai.com/v1",
        memoryApiKey: "global-openai-secret",
      }) as any;
    });

    expect(() => initConfig("/my/project")).toThrow(
      /Project config cannot set remote provider fields: memoryProvider/
    );
  });
});

describe("structured-output timeout derivation", () => {
  it("outer race = configured + 30000 so the inner timeout always fires first", () => {
    expect(outerStructuredOutputTimeoutMs(90_000)).toBe(120_000);
    expect(outerStructuredOutputTimeoutMs(180_000)).toBe(210_000);
    // Undefined falls back to the default (e.g. a partial CONFIG shape).
    expect(outerStructuredOutputTimeoutMs(undefined)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT + 30_000);
  });

  it("normalizeOpencodeTimeoutMs clamps and falls back to the default", () => {
    expect(normalizeOpencodeTimeoutMs(90_000)).toBe(90_000);
    expect(normalizeOpencodeTimeoutMs(5_000)).toBe(10_000);
    expect(normalizeOpencodeTimeoutMs(1_000_000)).toBe(600_000);
    expect(normalizeOpencodeTimeoutMs(undefined)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs(Number.NaN)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs(Number.POSITIVE_INFINITY)).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs("180000")).toBe(180_000);
    expect(normalizeOpencodeTimeoutMs(" 240000 ")).toBe(240_000);
    expect(normalizeOpencodeTimeoutMs("abc")).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
    expect(normalizeOpencodeTimeoutMs("")).toBe(OPENCODE_TIMEOUT_MS_DEFAULT);
  });
});
