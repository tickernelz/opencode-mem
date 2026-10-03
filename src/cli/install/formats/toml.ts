import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallHost } from "../catalog.js";
import { ensureParentDir, fileAction, resolveUserHome } from "../paths.js";
import type { InstallResult, McpLaunchSpec } from "../types.js";

function escapeTomlBasic(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function formatTomlMcpSection(
  launch: McpLaunchSpec,
  tableName = "mcp_servers.opencode-mem"
): string {
  const lines = [
    `[${tableName}]`,
    `command = "${escapeTomlBasic(launch.command)}"`,
    `args = [${launch.args.map((a) => `"${escapeTomlBasic(a)}"`).join(", ")}]`,
  ];
  if (launch.env && Object.keys(launch.env).length > 0) {
    const parts = Object.entries(launch.env).map(([k, v]) => `${k} = "${escapeTomlBasic(v)}"`);
    lines.push(`env = { ${parts.join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

/** Replace or append a TOML table section (Codex / Kimi-style). */
export function mergeTomlTableSection(existing: string, section: string, marker: string): string {
  const trimmedSection = section.trimEnd() + "\n";
  if (!existing.trim()) return trimmedSection;

  const start = existing.indexOf(marker);
  if (start === -1) {
    const base = existing.trimEnd();
    return `${base}\n\n${trimmedSection}`;
  }

  const rest = existing.slice(start + marker.length);
  const nextHeader = rest.search(/\n\[/);
  const end = nextHeader === -1 ? existing.length : start + marker.length + nextHeader;
  return `${existing.slice(0, start).trimEnd()}\n\n${trimmedSection}${existing
    .slice(end)
    .replace(/^\n+/, "")}`;
}

/** @deprecated use mergeTomlTableSection — kept for tests */
export function mergeCodexToml(existing: string, section: string): string {
  return mergeTomlTableSection(existing, section, "[mcp_servers.opencode-mem]");
}

export function installTomlMcpAt(
  path: string,
  launch: McpLaunchSpec,
  host: InstallHost
): InstallResult {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const section = formatTomlMcpSection(launch);
  const after = mergeTomlTableSection(before, section, "[mcp_servers.opencode-mem]");
  ensureParentDir(path);
  writeFileSync(path, after.endsWith("\n") ? after : `${after}\n`, { mode: 0o600 });
  return {
    host,
    path,
    action: fileAction(before, after),
    detail: `mcp_servers.opencode-mem → ${launch.command} ${launch.args.join(" ")}`,
  };
}

export function installTomlMcp(
  host: InstallHost,
  relativePath: string,
  launch: McpLaunchSpec
): InstallResult {
  return installTomlMcpAt(join(resolveUserHome(), relativePath), launch, host);
}

export function tomlHasMcp(path: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf-8").includes("[mcp_servers.opencode-mem]");
}
