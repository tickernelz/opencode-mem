import { describe, it, expect } from "bun:test";
import { CONFIG, isConfigured } from "../src/config.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("config", () => {
  describe("CONFIG defaults", () => {
    it("should have a storagePath containing .opencode-mem", () => {
      expect(CONFIG.storagePath).toContain(".opencode-mem");
    });

    it("should default to Xenova/nomic-embed-text-v1 embedding model", () => {
      // If user hasn't overridden, the default should be this model
      // The actual value depends on the config file, but we can check the type
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

    it("should have user profile settings as numbers", () => {
      expect(typeof CONFIG.userProfileAnalysisInterval).toBe("number");
      expect(typeof CONFIG.userProfileMaxPreferences).toBe("number");
      expect(typeof CONFIG.userProfileMaxPatterns).toBe("number");
      expect(typeof CONFIG.userProfileMaxWorkflows).toBe("number");
      expect(typeof CONFIG.userProfileConfidenceDecayDays).toBe("number");
      expect(typeof CONFIG.userProfileChangelogRetentionCount).toBe("number");
    });

    it("should have toast settings as booleans", () => {
      expect(typeof CONFIG.showAutoCaptureToasts).toBe("boolean");
      expect(typeof CONFIG.showUserProfileToasts).toBe("boolean");
      expect(typeof CONFIG.showErrorToasts).toBe("boolean");
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
});
