import { join } from "node:path";
import { getHostSpec } from "../../../shared/hosts.js";
import { mergeVscodeServersMcp } from "../formats/json.js";
import { copilotCliMcpPath, multiPathResult, vscodeUserMcpPath } from "../paths.js";
import type { InstallResult, McpLaunchSpec } from "../types.js";

export function installCopilot(
  userLaunch: McpLaunchSpec,
  projectLaunch: McpLaunchSpec,
  projectDir?: string
): InstallResult {
  const spec = getHostSpec("copilot");
  // VS Code user mcp.json uses `servers` + type:stdio (not mcpServers).
  const user = mergeVscodeServersMcp(vscodeUserMcpPath(), userLaunch, "copilot");
  const cli = mergeVscodeServersMcp(copilotCliMcpPath(), userLaunch, "copilot");
  const extras = [cli];
  if (projectDir && spec.projectConfigRelPath) {
    extras.push(
      mergeVscodeServersMcp(join(projectDir, spec.projectConfigRelPath), projectLaunch, "copilot")
    );
  }
  return multiPathResult("copilot", user, extras);
}
