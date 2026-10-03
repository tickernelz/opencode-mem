import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pinLaunchDirectory, resolveMcpLaunch, withoutLaunchDirectory } from "../launch.js";
import { fileAction, multiPathResult, resolveUserHome } from "../paths.js";
import type { InstallResult, McpLaunchSpec } from "../types.js";
import { readJsonFile, writeJsonFile } from "../formats/json.js";

export function installOpencode(projectDir?: string, launch?: McpLaunchSpec): InstallResult {
  const path = join(resolveUserHome(), ".config", "opencode", "opencode.json");
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const data = readJsonFile(path);
  const plugins = Array.isArray(data.plugins)
    ? [...(data.plugins as unknown[])]
    : Array.isArray(data.plugin)
      ? [...(data.plugin as unknown[])]
      : [];

  const wanted = "opencode-mem@latest";
  const hasMem = plugins.some(
    (p) => typeof p === "string" && (p === "opencode-mem" || p.startsWith("opencode-mem@"))
  );
  if (!hasMem) plugins.push(wanted);

  if (Array.isArray(data.plugins) || !Array.isArray(data.plugin)) {
    data.plugins = plugins;
  } else {
    data.plugin = plugins;
  }

  // Also register progressive MCP tools (plugin = deep hooks; MCP = timeline/search/get/write).
  const userLaunch = withoutLaunchDirectory(launch ?? resolveMcpLaunch(undefined, "opencode"));
  const mcpExisting =
    data.mcp && typeof data.mcp === "object" && !Array.isArray(data.mcp)
      ? ({ ...(data.mcp as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const userMcpEntry: Record<string, unknown> = {
    type: "local",
    command: [userLaunch.command, ...userLaunch.args],
    enabled: true,
    environment: {
      ...(userLaunch.env ?? {}),
      OPENCODE_MEM_PLATFORM: "opencode",
    },
  };
  mcpExisting["opencode-mem"] = userMcpEntry;
  data.mcp = mcpExisting;

  writeJsonFile(path, data);
  const after = readFileSync(path, "utf-8");

  const extras: InstallResult[] = [];
  // Project-local opencode.json when --cwd points at a repo.
  if (projectDir) {
    const projectPath = join(projectDir, "opencode.json");
    if (existsSync(projectPath) || existsSync(join(projectDir, ".git"))) {
      const projectLaunch = pinLaunchDirectory(userLaunch, projectDir);
      const projectMcpEntry: Record<string, unknown> = {
        type: "local",
        command: [projectLaunch.command, ...projectLaunch.args],
        enabled: true,
        cwd: projectDir,
        environment: {
          ...(projectLaunch.env ?? {}),
          OPENCODE_MEM_PLATFORM: "opencode",
        },
      };
      const projectBefore = existsSync(projectPath) ? readFileSync(projectPath, "utf-8") : "";
      const projectData = readJsonFile(projectPath);
      const projectMcp =
        projectData.mcp && typeof projectData.mcp === "object" && !Array.isArray(projectData.mcp)
          ? ({ ...(projectData.mcp as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      projectMcp["opencode-mem"] = projectMcpEntry;
      projectData.mcp = projectMcp;
      writeJsonFile(projectPath, projectData);
      const projectAfter = readFileSync(projectPath, "utf-8");
      extras.push({
        host: "opencode",
        path: projectPath,
        action: fileAction(projectBefore, projectAfter),
        detail: `mcp.opencode-mem (project)`,
      });
    }
  }

  const primary: InstallResult = {
    host: "opencode",
    path,
    action: fileAction(before, after),
    detail: hasMem
      ? `plugin + mcp.opencode-mem${projectDir ? ` (cwd=${projectDir})` : ""}`
      : `added ${wanted} + mcp.opencode-mem`,
  };
  return multiPathResult("opencode", primary, extras);
}

export function opencodeIsConfigured(): boolean {
  const path = join(resolveUserHome(), ".config", "opencode", "opencode.json");
  if (!existsSync(path)) return false;
  const data = readJsonFile(path);
  const plugins = Array.isArray(data.plugins)
    ? data.plugins
    : Array.isArray(data.plugin)
      ? data.plugin
      : [];
  const hasPlugin = plugins.some(
    (p) => typeof p === "string" && (p === "opencode-mem" || p.startsWith("opencode-mem@"))
  );
  const mcp =
    data.mcp && typeof data.mcp === "object" && !Array.isArray(data.mcp)
      ? (data.mcp as Record<string, unknown>)
      : {};
  return hasPlugin || Boolean(mcp["opencode-mem"]);
}
