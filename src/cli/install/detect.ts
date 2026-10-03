import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { HOST_SPECS, type HostId } from "../../shared/hosts.js";

function userHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Detect installed coding-agent hosts by well-known config / app directories
 * from the shared HostSpec catalog.
 */
export function detectInstalledHosts(home = userHome()): HostId[] {
  const found: HostId[] = [];
  for (const spec of HOST_SPECS) {
    if (spec.detectPaths(home).some((p) => existsSync(p))) {
      found.push(spec.id);
    }
  }
  return found;
}

/** @deprecated Use `detectInstalledHosts`. */
export const detectInstalledIdes = detectInstalledHosts;
