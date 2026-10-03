import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureParentDir, fileAction, resolveUserHome } from "../paths.js";
import type { InstallResult, McpLaunchSpec } from "../types.js";

function gooseEnvBlock(launch: McpLaunchSpec, indent = "    "): string {
  if (!launch.env || Object.keys(launch.env).length === 0) return "";
  return `${indent}envs:\n${Object.entries(launch.env)
    .map(([k, v]) => `${indent}  ${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n`;
}

export function installGooseYaml(launch: McpLaunchSpec): InstallResult {
  const path = join(resolveUserHome(), ".config", "goose", "config.yaml");
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const envBlock = gooseEnvBlock(launch);
  const block = [
    `extensions:`,
    `  opencode-mem:`,
    `    enabled: true`,
    `    type: stdio`,
    `    name: opencode-mem`,
    `    cmd: ${JSON.stringify(launch.command)}`,
    `    args:`,
    ...launch.args.map((a) => `      - ${JSON.stringify(a)}`),
    ...(envBlock ? envBlock.trimEnd().split("\n") : []),
    ``,
  ].join("\n");

  const extensionSnippet = `  opencode-mem:\n    enabled: true\n    type: stdio\n    name: opencode-mem\n    cmd: ${JSON.stringify(launch.command)}\n    args:\n${launch.args.map((a) => `      - ${JSON.stringify(a)}\n`).join("")}${envBlock}`;

  let after: string;
  if (!before.trim()) {
    after = block;
  } else if (
    /^\s*opencode-mem\s*:/m.test(before) ||
    /extensions:[\s\S]*opencode-mem:/m.test(before)
  ) {
    // Replace existing opencode-mem extension block under extensions:
    after = before.replace(/(\n)?[ \t]*opencode-mem:\n(?:[ \t]+.+\n)*/m, `\n${extensionSnippet}`);
    if (after === before && !before.includes("extensions:")) {
      after = `${before.trimEnd()}\n\n${block}`;
    } else if (after === before) {
      after = `${before.trimEnd()}\n${extensionSnippet}`;
    }
  } else if (before.includes("extensions:")) {
    after = `${before.trimEnd()}\n${extensionSnippet}`;
  } else {
    after = `${before.trimEnd()}\n\n${block}`;
  }

  ensureParentDir(path);
  writeFileSync(path, after.endsWith("\n") ? after : `${after}\n`, { mode: 0o600 });
  return {
    host: "goose",
    path,
    action: fileAction(before, after),
    detail: `extensions.opencode-mem → ${launch.command} ${launch.args.join(" ")}`,
  };
}

export function gooseHasMcp(path: string): boolean {
  if (!existsSync(path)) return false;
  return /opencode-mem\s*:/.test(readFileSync(path, "utf-8"));
}
