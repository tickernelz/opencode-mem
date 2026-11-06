import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripJsoncComments } from "../src/services/jsonc.js";

const tempDirs: string[] = [];
const legacyKeys = [
  "maxProfileItems",
  "userProfileDisplayPreferences",
  "userProfileDisplayPatterns",
  "userProfileDisplayWorkflows",
];
const injectionDefaults = {
  userProfileInjectPreferences: 5,
  userProfileInjectPatterns: 5,
  userProfileInjectWorkflows: 3,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function loadProfileConfig(settings?: Record<string, number>) {
  const home = mkdtempSync(join(tmpdir(), "opencode-mem-profile-config-"));
  tempDirs.push(home);
  const configDir = join(home, ".config", "opencode");
  const configPath = join(configDir, "opencode-mem.jsonc");
  if (settings) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(settings));
  }
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  const managerUrl = new URL(
    "../src/services/user-profile/user-profile-manager.ts",
    import.meta.url
  ).href;
  const contextUrl = new URL("../src/services/user-profile/profile-context.ts", import.meta.url)
    .href;
  const loggerUrl = new URL("../src/services/logger.ts", import.meta.url).href;
  const scriptPath = join(home, "scenario.mjs");
  writeFileSync(
    scriptPath,
    `import { mock } from "bun:test";
const { CONFIG } = await import(${JSON.stringify(configUrl)});
const items = (kind) => Array.from({ length: 8 }, (_, i) => ({
  category: kind + i, description: kind + i, confidence: 0.9,
  frequency: 1, lastSeen: Date.now(),
}));
mock.module(${JSON.stringify(managerUrl)}, () => ({ userProfileManager: {
  getActiveProfile: async () => ({ profileData: JSON.stringify({
    preferences: items("preference"), patterns: items("pattern"), workflows: items("workflow"),
  }) }),
} }));
mock.module(${JSON.stringify(loggerUrl)}, () => ({ log: () => {} }));
const { getUserProfileContext } = await import(${JSON.stringify(contextUrl)});
console.log(JSON.stringify({ config: CONFIG, context: await getUserProfileContext("fixture") }));`
  );
  const result = Bun.spawnSync([process.execPath, "run", scriptPath], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const output = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as {
    config: Record<string, number>;
    context: string;
  };
  return { ...output, file: readFileSync(configPath, "utf8") };
}

function expectInjectionCounts(
  context: string,
  preferences: number,
  patterns: number,
  workflows: number
) {
  expect(context.match(/^- \[preference/gm) ?? []).toHaveLength(preferences);
  expect(context.match(/^- \[pattern/gm) ?? []).toHaveLength(patterns);
  expect(context.match(/^- workflow/gm) ?? []).toHaveLength(workflows);
}

describe("deprecated profile configuration", () => {
  it("omits no-op options from newly generated config and retains injection defaults", () => {
    const { file, config, context } = loadProfileConfig();
    const template = JSON.parse(stripJsoncComments(file));
    for (const key of legacyKeys) expect(template).not.toHaveProperty(key);
    expect(template).toMatchObject(injectionDefaults);
    expect(config).toMatchObject(injectionDefaults);
    expectInjectionCounts(context, 5, 5, 3);
  });

  it("omits no-op options from the example config and retains injection defaults", () => {
    const example = JSON.parse(
      stripJsoncComments(
        readFileSync(new URL("../opencode-mem.example.jsonc", import.meta.url), "utf8")
      )
    );
    for (const key of legacyKeys) expect(example).not.toHaveProperty(key);
    expect(example).toMatchObject(injectionDefaults);
  });

  it("keeps existing legacy settings without rewriting files or changing injection", () => {
    const settings = Object.fromEntries(legacyKeys.map((key) => [key, 1]));
    const { config, file, context } = loadProfileConfig(settings);
    expect(config).toMatchObject(settings);
    expect(file).toBe(JSON.stringify(settings));
    expect(config).toMatchObject(injectionDefaults);
    expectInjectionCounts(context, 5, 5, 3);
  });

  it("uses the live injection limits independently of legacy settings", () => {
    const settings = {
      ...Object.fromEntries(legacyKeys.map((key) => [key, 99])),
      userProfileInjectPreferences: 2,
      userProfileInjectPatterns: 3,
      userProfileInjectWorkflows: 1,
    };
    const { config, context } = loadProfileConfig(settings);
    expect(config).toMatchObject(settings);
    expectInjectionCounts(context, 2, 3, 1);
  });
});
