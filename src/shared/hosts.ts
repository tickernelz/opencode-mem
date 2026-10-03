/**
 * Coding-agent host catalog — single source of truth for installable host IDs,
 * detection markers, config paths, and session priming.
 *
 * Shared by CLI install/status and domain provenance (`platformSource`).
 * Keep this free of CLI I/O so services can import it safely.
 *
 * Adding a host:
 * 1. Extend `HOST_IDS` + `HOST_SPECS` here.
 * 2. Wire install via `src/cli/install/` (`formats/` or `hosts/` adapter + `configKind`).
 * 3. Optional priming via `HostPrimingSpec`.
 * Do not add host-specific logic under Turso / AI / web-server.
 */

import { join } from "node:path";

export const HOST_IDS = [
  "cursor",
  "claude",
  "codex",
  "gemini",
  "antigravity",
  "opencode",
  "windsurf",
  "kimi",
  "openclaw",
  "goose",
  "warp",
  "copilot",
  "grok",
] as const;

export type HostId = (typeof HOST_IDS)[number];

/** CLI-facing alias for HostId (prefer `HostId`). */
export type InstallHost = HostId;
/** @deprecated Use `HostId` or `InstallHost`. */
export type InstallIde = HostId;

/** Host labels used as `platformSource` provenance for coding agents. */
export const INSTALL_HOST_PLATFORM_SOURCES: readonly HostId[] = HOST_IDS;

export type HostConfigKind =
  "json-mcpServers" | "toml" | "goose-yaml" | "openclaw" | "opencode" | "copilot";

export type HostPrimingKind = "cursor-mdc" | "marked-section" | "rules-md";

export interface HostPrimingSpec {
  kind: HostPrimingKind;
  /** Path relative to projectDir */
  relPath: string;
  detail: string;
  /** Heading for marked-section priming blocks */
  heading?: string;
}

export interface HostSpec {
  id: HostId;
  nextSteps: string;
  aliases?: readonly string[];
  configKind: HostConfigKind;
  /** Paths under home that indicate the host is installed */
  detectPaths: (home: string) => string[];
  /** User-global MCP/plugin config paths (status / isConfigured) */
  userConfigPaths: (home: string) => string[];
  /** Optional project-local MCP config path relative to projectDir */
  projectConfigRelPath?: string;
  priming?: HostPrimingSpec;
}

export function vscodeAppDir(home: string): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Code");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Code");
  }
  return join(home, ".config", "Code");
}

export function vscodeUserMcpPathForHome(home: string): string {
  return join(vscodeAppDir(home), "User", "mcp.json");
}

export function copilotCliMcpPathForHome(home: string): string {
  return join(home, ".copilot", "mcp-config.json");
}

export const HOST_SPECS: readonly HostSpec[] = [
  {
    id: "cursor",
    nextSteps: "Restart Cursor (MCP → Tools) so opencode-mem loads",
    configKind: "json-mcpServers",
    detectPaths: (home) => [
      join(home, ".cursor"),
      join(home, "Library", "Application Support", "Cursor"),
    ],
    userConfigPaths: (home) => [join(home, ".cursor", "mcp.json")],
    projectConfigRelPath: join(".cursor", "mcp.json"),
    priming: {
      kind: "cursor-mdc",
      relPath: join(".cursor", "rules", "opencode-mem.mdc"),
      detail: "Cursor alwaysApply rule → memory_timeline priming",
    },
  },
  {
    id: "claude",
    nextSteps: "Restart Claude Code / Claude Desktop so MCP tools appear",
    aliases: ["claude-code"],
    configKind: "json-mcpServers",
    detectPaths: (home) => [join(home, ".claude"), join(home, ".claude.json")],
    userConfigPaths: (home) => [join(home, ".claude.json")],
    projectConfigRelPath: ".mcp.json",
    priming: {
      kind: "marked-section",
      relPath: "CLAUDE.md",
      heading: "## Project memory (opencode-mem)",
      detail: "CLAUDE.md priming block → memory_timeline",
    },
  },
  {
    id: "codex",
    nextSteps: "Restart Codex CLI, then verify with /mcp",
    aliases: ["codex-cli"],
    configKind: "toml",
    detectPaths: (home) => [join(home, ".codex")],
    userConfigPaths: (home) => [join(home, ".codex", "config.toml")],
    projectConfigRelPath: join(".codex", "config.toml"),
  },
  {
    id: "gemini",
    nextSteps: "Restart Gemini CLI so ~/.gemini MCP settings reload",
    configKind: "json-mcpServers",
    detectPaths: (home) => [join(home, ".gemini")],
    userConfigPaths: (home) => [join(home, ".gemini", "settings.json")],
    projectConfigRelPath: join(".gemini", "settings.json"),
    priming: {
      kind: "marked-section",
      relPath: "GEMINI.md",
      heading: "## Project memory (opencode-mem)",
      detail: "GEMINI.md priming block → memory_timeline",
    },
  },
  {
    id: "antigravity",
    nextSteps: "Restart Antigravity / Gemini so mcp_config reloads",
    aliases: ["antigravity-cli"],
    configKind: "json-mcpServers",
    detectPaths: (home) => [join(home, ".gemini", "config"), join(home, ".gemini", "antigravity")],
    userConfigPaths: (home) => [join(home, ".gemini", "config", "mcp_config.json")],
    projectConfigRelPath: join(".agents", "mcp_config.json"),
    priming: {
      kind: "marked-section",
      relPath: "GEMINI.md",
      heading: "## Project memory (opencode-mem)",
      detail: "GEMINI.md priming block → memory_timeline",
    },
  },
  {
    id: "opencode",
    nextSteps: "Restart OpenCode — plugin + MCP both registered",
    configKind: "opencode",
    detectPaths: (home) => [join(home, ".config", "opencode"), join(home, ".opencode")],
    userConfigPaths: (home) => [join(home, ".config", "opencode", "opencode.json")],
    projectConfigRelPath: "opencode.json",
  },
  {
    id: "windsurf",
    nextSteps: "Restart Windsurf so mcp_config.json reloads",
    configKind: "json-mcpServers",
    detectPaths: (home) => [
      join(home, ".codeium", "windsurf"),
      join(home, "Library", "Application Support", "Windsurf"),
    ],
    userConfigPaths: (home) => [join(home, ".codeium", "windsurf", "mcp_config.json")],
    priming: {
      kind: "rules-md",
      relPath: join(".windsurf", "rules", "opencode-mem.md"),
      detail: "Windsurf rules priming → memory_timeline",
    },
  },
  {
    id: "kimi",
    nextSteps: "Restart Kimi Code so mcp.json + config.toml reload",
    configKind: "json-mcpServers",
    detectPaths: (home) => [join(home, ".kimi-code")],
    userConfigPaths: (home) => [join(home, ".kimi-code", "mcp.json")],
    projectConfigRelPath: join(".kimi-code", "mcp.json"),
    priming: {
      kind: "rules-md",
      relPath: join(".kimi-code", "rules", "opencode-mem.md"),
      detail: "Kimi rules priming → memory_timeline",
    },
  },
  {
    id: "openclaw",
    nextSteps: "Restart OpenClaw so ~/.openclaw/mcp.json reloads",
    configKind: "openclaw",
    detectPaths: (home) => [join(home, ".openclaw")],
    userConfigPaths: (home) => [join(home, ".openclaw", "openclaw.json")],
  },
  {
    id: "goose",
    nextSteps: "Restart Goose so the opencode-mem extension loads",
    configKind: "goose-yaml",
    detectPaths: (home) => [join(home, ".config", "goose")],
    userConfigPaths: (home) => [join(home, ".config", "goose", "config.yaml")],
  },
  {
    id: "warp",
    nextSteps: "Restart Warp so ~/.warp/mcp.json reloads",
    configKind: "json-mcpServers",
    detectPaths: (home) => [join(home, ".warp")],
    userConfigPaths: (home) => [join(home, ".warp", ".mcp.json")],
    projectConfigRelPath: join(".warp", ".mcp.json"),
  },
  {
    id: "copilot",
    nextSteps: "Reload VS Code / Copilot Chat window so User mcp.json loads",
    aliases: ["github-copilot"],
    configKind: "copilot",
    detectPaths: (home) => [vscodeAppDir(home), join(home, ".copilot")],
    userConfigPaths: (home) => [vscodeUserMcpPathForHome(home), copilotCliMcpPathForHome(home)],
    projectConfigRelPath: join(".vscode", "mcp.json"),
  },
  {
    id: "grok",
    nextSteps: "Restart Grok so ~/.grok/mcp.json reloads",
    configKind: "toml",
    detectPaths: (home) => [join(home, ".grok")],
    userConfigPaths: (home) => [join(home, ".grok", "config.toml")],
    projectConfigRelPath: join(".grok", "config.toml"),
  },
];

const HOST_BY_ID: ReadonlyMap<HostId, HostSpec> = new Map(HOST_SPECS.map((s) => [s.id, s]));

export function getHostSpec(id: HostId): HostSpec {
  const spec = HOST_BY_ID.get(id);
  if (!spec) throw new Error(`Unknown host: ${id}`);
  return spec;
}

export const SUPPORTED_HOSTS: HostId[] = [...HOST_IDS];
/** @deprecated Use `SUPPORTED_HOSTS`. */
export const SUPPORTED_IDES = SUPPORTED_HOSTS;

export const HOST_ALIASES: Record<string, HostId> = Object.fromEntries(
  HOST_SPECS.flatMap((s) => (s.aliases ?? []).map((alias) => [alias, s.id]))
);
/** @deprecated Use `HOST_ALIASES`. */
export const IDE_ALIASES = HOST_ALIASES;

export const HOST_NEXT_STEPS: Record<HostId, string> = Object.fromEntries(
  HOST_SPECS.map((s) => [s.id, s.nextSteps])
) as Record<HostId, string>;
/** @deprecated Use `HOST_NEXT_STEPS`. */
export const IDE_NEXT_STEPS = HOST_NEXT_STEPS;
