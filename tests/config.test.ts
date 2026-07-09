import { afterAll, describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "opencode-mem-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

const {
  CONFIG,
  getAutoCaptureProviderStatus,
  hasAutoCaptureProviderConfig,
  isConfigured,
  isPlaceholderApiKey,
} = await import("../src/config.js");

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
});

describe("config", () => {
  describe("CONFIG defaults", () => {
    it("should have a storagePath as a valid string", () => {
      expect(typeof CONFIG.storagePath).toBe("string");
      expect(CONFIG.storagePath.length).toBeGreaterThan(0);
    });

    it("should default to Xenova/nomic-embed-text-v1 embedding model", () => {
      expect(typeof CONFIG.embeddingModel).toBe("string");
    });

    it("should have numeric embeddingDimensions", () => {
      expect(typeof CONFIG.embeddingDimensions).toBe("number");
      expect(CONFIG.embeddingDimensions).toBeGreaterThan(0);
    });

    it("should have similarityThreshold between 0 and 1", () => {
      expect(CONFIG.similarityThreshold).toBeGreaterThanOrEqual(0);
      expect(CONFIG.similarityThreshold).toBeLessThanOrEqual(1);
    });

    it("should have positive maxMemories", () => {
      expect(CONFIG.maxMemories).toBeGreaterThan(0);
    });

    it("should have webServerPort as a number", () => {
      expect(typeof CONFIG.webServerPort).toBe("number");
    });

    it("should have webServerHost as a string", () => {
      expect(typeof CONFIG.webServerHost).toBe("string");
    });

    it("should have maxVectorsPerShard as a positive number", () => {
      expect(CONFIG.maxVectorsPerShard).toBeGreaterThan(0);
    });

    it("should have compaction settings", () => {
      expect(CONFIG.compaction).toBeDefined();
      expect(typeof CONFIG.compaction.enabled).toBe("boolean");
      expect(typeof CONFIG.compaction.memoryLimit).toBe("number");
    });

    it("should have chatMessage settings", () => {
      expect(CONFIG.chatMessage).toBeDefined();
      expect(typeof CONFIG.chatMessage.enabled).toBe("boolean");
      expect(typeof CONFIG.chatMessage.maxMemories).toBe("number");
      expect(typeof CONFIG.chatMessage.excludeCurrentSession).toBe("boolean");
    });

    it("should have chatMessage.injectOn as 'first' or 'always'", () => {
      expect(["first", "always"]).toContain(CONFIG.chatMessage.injectOn);
    });

    it("should have boolean toggle settings", () => {
      expect(typeof CONFIG.autoCaptureEnabled).toBe("boolean");
      expect(typeof CONFIG.injectProfile).toBe("boolean");
      expect(typeof CONFIG.webServerEnabled).toBe("boolean");
      expect(typeof CONFIG.autoCleanupEnabled).toBe("boolean");
      expect(typeof CONFIG.deduplicationEnabled).toBe("boolean");
    });

    it("should expose memory scope config", () => {
      const defaultScope = CONFIG.memory.defaultScope ?? "project";
      expect(["project", "all-projects"]).toContain(defaultScope);
    });

    it("should have user profile settings as numbers", () => {
      expect(typeof CONFIG.userProfileAnalysisInterval).toBe("number");
      expect(typeof CONFIG.userProfileDisplayPreferences).toBe("number");
      expect(typeof CONFIG.userProfileDisplayPatterns).toBe("number");
      expect(typeof CONFIG.userProfileDisplayWorkflows).toBe("number");
      expect(typeof CONFIG.userProfileConfidenceDecayDays).toBe("number");
      expect(typeof CONFIG.userProfileChangelogRetentionCount).toBe("number");
    });

    it("should have toast settings as booleans", () => {
      expect(typeof CONFIG.showAutoCaptureToasts).toBe("boolean");
      expect(typeof CONFIG.showUserProfileToasts).toBe("boolean");
      expect(typeof CONFIG.showErrorToasts).toBe("boolean");
    });

    it("should not treat template manual API placeholders as usable auto-capture config", () => {
      expect(
        hasAutoCaptureProviderConfig({
          ...CONFIG,
          opencodeProvider: undefined,
          opencodeModel: undefined,
          memoryModel: "gpt-4o-mini",
          memoryApiUrl: "https://api.openai.com/v1",
          memoryApiKey: "sk-...",
        })
      ).toBe(false);
    });

    it("should treat opencode provider settings as usable auto-capture config", () => {
      expect(
        hasAutoCaptureProviderConfig({
          ...CONFIG,
          opencodeProvider: "anthropic",
          opencodeModel: "claude-haiku-4-5-20251001",
          memoryModel: undefined,
          memoryApiUrl: undefined,
          memoryApiKey: undefined,
        })
      ).toBe(true);
    });

    it("should report manual provider mode when model, API URL, and API key are configured", () => {
      expect(
        getAutoCaptureProviderStatus({
          ...CONFIG,
          opencodeProvider: undefined,
          opencodeModel: undefined,
          memoryModel: "local-model",
          memoryApiUrl: "http://127.0.0.1:11434/v1",
          memoryApiKey: "local-api-key",
        })
      ).toEqual({ ready: true, mode: "manual", issues: [] });
    });

    it("should report missing memoryApiKey when model and API URL are configured without a key", () => {
      expect(
        getAutoCaptureProviderStatus({
          ...CONFIG,
          opencodeProvider: undefined,
          opencodeModel: undefined,
          memoryModel: "gpt-4o-mini",
          memoryApiUrl: "https://api.openai.com/v1",
          memoryApiKey: undefined,
        })
      ).toEqual({
        ready: false,
        issues: [
          "opencodeProvider is not configured",
          "opencodeModel is not configured",
          "memoryApiKey is not configured",
        ],
      });
    });

    it("should report each missing manual provider field independently", () => {
      expect(
        getAutoCaptureProviderStatus({
          ...CONFIG,
          opencodeProvider: undefined,
          opencodeModel: undefined,
          memoryModel: undefined,
          memoryApiUrl: undefined,
          memoryApiKey: "sk-...",
        })
      ).toEqual({
        ready: false,
        issues: [
          "opencodeProvider is not configured",
          "opencodeModel is not configured",
          "memoryModel is not configured",
          "memoryApiUrl is not configured",
          "memoryApiKey contains a placeholder value",
        ],
      });
    });

    it("should expose the resolved auto-capture provider status on CONFIG", () => {
      expect(CONFIG.autoCaptureProviderStatus).toEqual(getAutoCaptureProviderStatus(CONFIG));
    });
  });

  describe("isConfigured", () => {
    it("should return true", () => {
      expect(isConfigured()).toBe(true);
    });

    it("should return a boolean", () => {
      expect(typeof isConfigured()).toBe("boolean");
    });
  });

  describe("placeholder API key detection", () => {
    it("treats template API keys as placeholders", () => {
      expect(isPlaceholderApiKey("sk-...")).toBe(true);
      expect(isPlaceholderApiKey("sk-ant-...")).toBe(true);
      expect(isPlaceholderApiKey("gsk_...")).toBe(true);
    });

    it("does not treat real-looking or absent API keys as placeholders", () => {
      expect(isPlaceholderApiKey("sk-test-realish")).toBe(false);
      expect(isPlaceholderApiKey(undefined)).toBe(false);
    });
  });
});
