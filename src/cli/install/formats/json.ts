import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallHost } from "../catalog.js";
import { ensureParentDir, fileAction, resolveUserHome } from "../paths.js";
import type { InstallResult, McpLaunchSpec } from "../types.js";

export function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return parsed as Record<string, unknown>;
}

export function writeJsonFile(path: string, data: Record<string, unknown>): void {
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function mcpServerEntry(launch: McpLaunchSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: launch.command,
    args: launch.args,
  };
  if (launch.env && Object.keys(launch.env).length > 0) {
    entry.env = launch.env;
  }
  return entry;
}

export function mergeJsonMcpServers(
  path: string,
  key: "mcpServers" | "mcp",
  launch: McpLaunchSpec,
  host: InstallHost,
  serverName = "opencode-mem"
): InstallResult {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const data = readJsonFile(path);
  const existing =
    data[key] && typeof data[key] === "object" && !Array.isArray(data[key])
      ? ({ ...(data[key] as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  existing[serverName] = mcpServerEntry(launch);
  data[key] = existing;
  writeJsonFile(path, data);
  const after = readFileSync(path, "utf-8");
  return {
    host,
    path,
    action: fileAction(before, after),
    detail: `${key}.${serverName} → ${launch.command} ${launch.args.join(" ")}`,
  };
}

/** VS Code / Copilot project format uses `servers` + type:stdio. */
export function mergeVscodeServersMcp(
  path: string,
  launch: McpLaunchSpec,
  host: InstallHost,
  serverName = "opencode-mem"
): InstallResult {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const data = readJsonFile(path);
  const existing =
    data.servers && typeof data.servers === "object" && !Array.isArray(data.servers)
      ? ({ ...(data.servers as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const entry: Record<string, unknown> = {
    type: "stdio",
    command: launch.command,
    args: launch.args,
  };
  if (launch.env && Object.keys(launch.env).length > 0) {
    entry.env = launch.env;
  }
  existing[serverName] = entry;
  data.servers = existing;
  writeJsonFile(path, data);
  const after = readFileSync(path, "utf-8");
  return {
    host,
    path,
    action: fileAction(before, after),
    detail: `servers.${serverName} → ${launch.command} ${launch.args.join(" ")}`,
  };
}

export function installJsonMcp(
  host: InstallHost,
  relativePath: string,
  launch: McpLaunchSpec,
  key: "mcpServers" | "mcp" = "mcpServers"
): InstallResult {
  return mergeJsonMcpServers(join(resolveUserHome(), relativePath), key, launch, host);
}

export function jsonHasMcpServer(path: string, name = "opencode-mem"): boolean {
  if (!existsSync(path)) return false;
  const data = readJsonFile(path);
  for (const key of ["mcpServers", "mcp", "servers"] as const) {
    const block = data[key];
    if (block && typeof block === "object" && !Array.isArray(block) && name in block) {
      return true;
    }
  }
  return false;
}
