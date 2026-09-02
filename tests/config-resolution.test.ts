import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { initConfig, CONFIG } from "../src/config.js";

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

  it("falls back to defaults when neither global nor project config exists", () => {
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
    initConfig("/no/config/project");
    expect(CONFIG.autoCaptureEnabled).toBe(true); // default value
    expect(CONFIG.opencodeProvider).toBeUndefined();
  });
});
