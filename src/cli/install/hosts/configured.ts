import { getHostSpec, type HostId } from "../../../shared/hosts.js";
import { jsonHasMcpServer } from "../formats/json.js";
import { openClawHasMcp } from "../formats/openclaw.js";
import { tomlHasMcp } from "../formats/toml.js";
import { gooseHasMcp } from "../formats/yaml-goose.js";
import { resolveUserHome } from "../paths.js";
import { opencodeIsConfigured } from "./opencode.js";

/**
 * Whether a host config file already contains an opencode-mem MCP / plugin entry.
 * Used by `status` to show install coverage without mutating files.
 */
export function isHostConfigured(host: HostId): boolean {
  const home = resolveUserHome();
  const spec = getHostSpec(host);
  try {
    switch (spec.configKind) {
      case "json-mcpServers":
        return spec.userConfigPaths(home).some((p) => jsonHasMcpServer(p));
      case "toml":
        return spec.userConfigPaths(home).some((p) => tomlHasMcp(p));
      case "openclaw":
        return spec.userConfigPaths(home).some((p) => openClawHasMcp(p));
      case "goose-yaml":
        return spec.userConfigPaths(home).some((p) => gooseHasMcp(p));
      case "opencode":
        return opencodeIsConfigured();
      case "copilot":
        return spec.userConfigPaths(home).some((p) => jsonHasMcpServer(p));
      default: {
        const _exhaustive: never = spec.configKind;
        void _exhaustive;
        return false;
      }
    }
  } catch {
    return false;
  }
}

/** @deprecated Use `isHostConfigured`. */
export const isIdeConfigured = isHostConfigured;
