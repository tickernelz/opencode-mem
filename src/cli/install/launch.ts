import { resolve } from "node:path";
import { resolveProjectDir } from "./paths.js";
import type { McpLaunchSpec } from "./types.js";

/**
 * Prefer the currently running CLI entry (local checkout / installed bin).
 * Fall back to `npx -y opencode-mem mcp` for portable host configs.
 *
 * Does NOT pin OPENCODE_MEM_DIRECTORY — user-global configs must follow the
 * host cwd. Use `pinLaunchDirectory` only for project-scoped writes.
 */
export function resolveMcpLaunch(
  projectDir?: string,
  platformSource: string = "mcp"
): McpLaunchSpec {
  // projectDir kept for call-site compat; intentionally not baked into env here.
  void projectDir;
  const entry = process.argv[1];
  const env: Record<string, string> = {
    OPENCODE_MEM_PLATFORM: platformSource,
  };

  if (entry && (entry.endsWith(".js") || entry.endsWith(".ts") || entry.endsWith(".mjs"))) {
    return {
      command: process.execPath,
      args: [resolve(entry), "mcp"],
      env,
    };
  }

  return {
    command: "npx",
    args: ["-y", "opencode-mem", "mcp"],
    env,
  };
}

/** Pin shard directory for project-local MCP configs only. */
export function pinLaunchDirectory(launch: McpLaunchSpec, projectDir?: string): McpLaunchSpec {
  const resolved = resolveProjectDir(projectDir);
  if (!resolved) return launch;
  return {
    ...launch,
    env: {
      ...(launch.env ?? {}),
      OPENCODE_MEM_DIRECTORY: resolved,
    },
  };
}

/** Strip directory pin so user-global configs stay multi-project safe. */
export function withoutLaunchDirectory(launch: McpLaunchSpec): McpLaunchSpec {
  if (!launch.env?.OPENCODE_MEM_DIRECTORY) return launch;
  const env = { ...launch.env };
  delete env.OPENCODE_MEM_DIRECTORY;
  return { ...launch, env };
}
