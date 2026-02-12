import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runConfigInIsolatedHome(setup?: (homeDir: string) => void): {
  config: Record<string, unknown>;
  isConfigured: boolean;
  homeDir: string;
} {
  const homeDir = mkdtempSync(join(tmpdir(), "opencode-mem-config-test-"));

  try {
    setup?.(homeDir);

    const script = `
      const mod = await import("./src/config.js?cachebust=" + Date.now());
      const output = {
        storagePath: mod.CONFIG.storagePath,
        embeddingModel: mod.CONFIG.embeddingModel,
        embeddingDimensions: mod.CONFIG.embeddingDimensions,
        similarityThreshold: mod.CONFIG.similarityThreshold,
        maxMemories: mod.CONFIG.maxMemories,
        injectProfile: mod.CONFIG.injectProfile,
        containerTagPrefix: mod.CONFIG.containerTagPrefix,
        webServerPort: mod.CONFIG.webServerPort,
        webServerHost: mod.CONFIG.webServerHost,
        isConfigured: mod.isConfigured(),
      };
      console.log(JSON.stringify(output));
    `;

    const proc = spawnSync(process.execPath, ["--eval", script], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOME: homeDir,
      },
      encoding: "utf-8",
    });

    const stdout = proc.stdout.trim();
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("{") && entry.endsWith("}"));

    if (!line) {
      throw new Error(`Missing JSON output. stdout: ${stdout} stderr: ${proc.stderr}`);
    }

    const parsed = JSON.parse(line) as Record<string, unknown> & {
      isConfigured: boolean;
    };

    return {
      config: parsed,
      isConfigured: parsed.isConfigured,
      homeDir,
    };
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

describe("Config Module", () => {
  it("expands ~ paths from config", () => {
    const result = runConfigInIsolatedHome((homeDir) => {
      const configDir = join(homeDir, ".config", "opencode");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "opencode-mem.jsonc"),
        JSON.stringify({ storagePath: "~/.custom-memory/data" }),
        "utf-8"
      );
    });

    expect(result.config.storagePath).toBe(join(result.homeDir, ".custom-memory", "data"));
  });

  it("uses correct default CONFIG values", () => {
    const result = runConfigInIsolatedHome();

    expect(result.config.embeddingModel).toBe("Xenova/nomic-embed-text-v1");
    expect(result.config.embeddingDimensions).toBe(768);
    expect(result.config.similarityThreshold).toBe(0.6);
    expect(result.config.maxMemories).toBe(10);
    expect(result.config.injectProfile).toBe(true);
    expect(result.config.containerTagPrefix).toBe("opencode");
    expect(result.config.webServerPort).toBe(4747);
    expect(result.config.webServerHost).toBe("127.0.0.1");
  });

  it("isConfigured returns true", () => {
    const result = runConfigInIsolatedHome();
    expect(result.isConfigured).toBe(true);
  });
});
