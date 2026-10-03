/**
 * Host install entrypoints. New hosts: catalog in `shared/hosts.ts`, then
 * format/adapter here — see docs/mcp.md "Adding a host".
 */
import { join } from "node:path";
import { getHostSpec, type HostId } from "../../shared/hosts.js";
import { installHostPriming } from "./priming.js";
import type { InstallHost } from "./catalog.js";
import { mergeJsonMcpServers } from "./formats/json.js";
import { mergeOpenClawServers } from "./formats/openclaw.js";
import { installTomlMcpAt } from "./formats/toml.js";
import { installGooseYaml } from "./formats/yaml-goose.js";
import { installCopilot } from "./hosts/copilot.js";
import { installOpencode } from "./hosts/opencode.js";
import { pinLaunchDirectory, resolveMcpLaunch, withoutLaunchDirectory } from "./launch.js";
import { multiPathResult, resolveProjectDir, resolveUserHome } from "./paths.js";
import type { InstallResult, McpLaunchSpec } from "./types.js";

export type { InstallHost, InstallIde } from "./catalog.js";
export {
  HOST_ALIASES,
  HOST_NEXT_STEPS,
  IDE_ALIASES,
  IDE_NEXT_STEPS,
  INSTALL_HOST_PLATFORM_SOURCES,
  SUPPORTED_HOSTS,
  SUPPORTED_IDES,
  parseHostList,
  parseIdeList,
  resolveHostAlias,
  resolveIdeAlias,
} from "./catalog.js";
export type { InstallResult, McpLaunchSpec } from "./types.js";
export { pinLaunchDirectory, resolveMcpLaunch, withoutLaunchDirectory } from "./launch.js";
export { resolveUserHome } from "./paths.js";
export { mergeCodexToml, mergeTomlTableSection } from "./formats/toml.js";
export { isHostConfigured, isIdeConfigured } from "./hosts/configured.js";
export { detectInstalledHosts, detectInstalledIdes } from "./detect.js";
export { installHostPriming, installIdePriming } from "./priming.js";

/** Project-local session priming (rules / CLAUDE.md) for MCP-only hosts. */
function withPriming(
  host: InstallHost,
  primary: InstallResult,
  projectDir?: string
): InstallResult {
  const priming = installHostPriming(host, projectDir);
  if (!priming.length) return primary;
  return multiPathResult(host, primary, priming);
}

function installJsonHost(
  host: HostId,
  userLaunch: McpLaunchSpec,
  projectLaunch: McpLaunchSpec,
  projectDir?: string
): InstallResult {
  const spec = getHostSpec(host);
  const home = resolveUserHome();
  const userPath = spec.userConfigPaths(home)[0];
  if (!userPath) throw new Error(`Host ${host} has no user config path`);

  const user = mergeJsonMcpServers(userPath, "mcpServers", userLaunch, host);
  if (!projectDir || !spec.projectConfigRelPath) {
    return withPriming(host, user, projectDir);
  }
  const project = mergeJsonMcpServers(
    join(projectDir, spec.projectConfigRelPath),
    "mcpServers",
    projectLaunch,
    host
  );
  return withPriming(host, multiPathResult(host, user, [project]), projectDir);
}

function installTomlHost(
  host: HostId,
  userLaunch: McpLaunchSpec,
  projectLaunch: McpLaunchSpec,
  projectDir?: string
): InstallResult {
  const spec = getHostSpec(host);
  const home = resolveUserHome();
  const userPath = spec.userConfigPaths(home)[0];
  if (!userPath) throw new Error(`Host ${host} has no user config path`);

  const user = installTomlMcpAt(userPath, userLaunch, host);
  if (!projectDir || !spec.projectConfigRelPath) return user;
  const project = installTomlMcpAt(
    join(projectDir, spec.projectConfigRelPath),
    projectLaunch,
    host
  );
  return multiPathResult(host, user, [project]);
}

export function installHost(
  host: InstallHost,
  options: { projectDir?: string; launch?: McpLaunchSpec } = {}
): InstallResult {
  const projectDir = resolveProjectDir(options.projectDir);
  const baseLaunch =
    options.launch ?? resolveMcpLaunch(projectDir, host === "opencode" ? "opencode" : host);
  // User-global configs must not pin a single project directory.
  const userLaunch = withoutLaunchDirectory(baseLaunch);
  const projectLaunch = pinLaunchDirectory(userLaunch, projectDir);
  const spec = getHostSpec(host);

  switch (spec.configKind) {
    case "json-mcpServers":
      return installJsonHost(host, userLaunch, projectLaunch, projectDir);
    case "toml":
      return installTomlHost(host, userLaunch, projectLaunch, projectDir);
    case "opencode":
      return installOpencode(projectDir, userLaunch);
    case "openclaw":
      return mergeOpenClawServers(spec.userConfigPaths(resolveUserHome())[0]!, userLaunch);
    case "goose-yaml":
      return installGooseYaml(userLaunch);
    case "copilot":
      return installCopilot(userLaunch, projectLaunch, projectDir);
    default: {
      const _exhaustive: never = spec.configKind;
      throw new Error(`Unsupported host config kind: ${_exhaustive}`);
    }
  }
}

/** @deprecated Use `installHost`. */
export const installIde = installHost;

export function runInstall(options: {
  hosts: InstallHost[];
  projectDir?: string;
}): InstallResult[] {
  const projectDir = resolveProjectDir(options.projectDir);
  return options.hosts.map((host) =>
    installHost(host, {
      projectDir,
      launch: resolveMcpLaunch(projectDir, host === "opencode" ? "opencode" : host),
    })
  );
}
