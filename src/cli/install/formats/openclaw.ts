import { existsSync, readFileSync } from "node:fs";
import { fileAction } from "../paths.js";
import type { InstallResult, McpLaunchSpec } from "../types.js";
import { mcpServerEntry, readJsonFile, writeJsonFile } from "./json.js";

/** OpenClaw: mcp.servers inside ~/.openclaw/openclaw.json */
export function mergeOpenClawServers(path: string, launch: McpLaunchSpec): InstallResult {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const data = readJsonFile(path);
  const mcp =
    data.mcp && typeof data.mcp === "object" && !Array.isArray(data.mcp)
      ? ({ ...(data.mcp as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const servers =
    mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)
      ? ({ ...(mcp.servers as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  servers["opencode-mem"] = mcpServerEntry(launch);
  mcp.servers = servers;
  data.mcp = mcp;
  writeJsonFile(path, data);
  const after = readFileSync(path, "utf-8");
  return {
    host: "openclaw",
    path,
    action: fileAction(before, after),
    detail: `mcp.servers.opencode-mem → ${launch.command} ${launch.args.join(" ")}`,
  };
}

export function openClawHasMcp(path: string, name = "opencode-mem"): boolean {
  if (!existsSync(path)) return false;
  const data = readJsonFile(path);
  const mcp = data.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return false;
  const servers = (mcp as Record<string, unknown>).servers;
  return Boolean(
    servers && typeof servers === "object" && !Array.isArray(servers) && name in servers
  );
}
