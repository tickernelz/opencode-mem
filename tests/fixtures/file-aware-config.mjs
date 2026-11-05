import { mock } from "bun:test";
import * as os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDirectory = process.argv[2];
// Isolate actual config reads/writes without changing HOME or touching the
// account's OpenCode configuration. This fixture runs in its own process.
mock.module("node:os", () => ({ ...os, homedir: () => fixtureDirectory }));
const globalPath = join(fixtureDirectory, ".config", "opencode", "opencode-mem.jsonc");
const projectDirectory = join(fixtureDirectory, "project");
const projectPath = join(projectDirectory, ".opencode", "opencode-mem.jsonc");
mkdirSync(join(fixtureDirectory, ".config", "opencode"), { recursive: true });
mkdirSync(join(projectDirectory, ".opencode"), { recursive: true });
writeFileSync(globalPath, "{}");
const config = await import("../../src/config.js");
const result = { initial: config.CONFIG.chatMessage.fileAwareRecall };
function load(name, globalConfig, projectConfig = {}) {
  writeFileSync(globalPath, JSON.stringify(globalConfig));
  writeFileSync(projectPath, JSON.stringify(projectConfig));
  config.initConfig(projectDirectory);
  result[name] = config.CONFIG.chatMessage.fileAwareRecall;
}
load("omitted", {});
load("missingFlag", { chatMessage: { maxMemories: 2 } });
load("enabled", { chatMessage: { fileAwareRecall: true } });
load("disabled", { chatMessage: { fileAwareRecall: false } });
for (const value of [null, "false", "true", 0, 1, [], {}]) {
  load(`invalid:${JSON.stringify(value)}`, { chatMessage: { fileAwareRecall: value } });
}
load(
  "globalOptOutWithUnrelatedProject",
  { chatMessage: { fileAwareRecall: false } },
  {
    chatMessage: { maxMemories: 1 },
  }
);
load(
  "explicitProjectOptIn",
  { chatMessage: { fileAwareRecall: false } },
  {
    chatMessage: { fileAwareRecall: true },
  }
);
load(
  "explicitProjectOptOut",
  { chatMessage: { fileAwareRecall: true } },
  {
    chatMessage: { fileAwareRecall: false },
  }
);
load(
  "invalidProjectValue",
  { chatMessage: { fileAwareRecall: false } },
  {
    chatMessage: { fileAwareRecall: "false" },
  }
);
for (const value of [null, "false", "true", 0, 1, [], {}]) {
  load(
    `invalid-project:${JSON.stringify(value)}`,
    { chatMessage: { fileAwareRecall: false } },
    {
      chatMessage: { fileAwareRecall: value },
    }
  );
}
load("otherDefaults", {});
result.updateOnCaptureEnabled = config.CONFIG.updateOnCaptureEnabled;
result.dreamingEnabled = config.CONFIG.dreaming.enabled;
console.log(JSON.stringify(result));
