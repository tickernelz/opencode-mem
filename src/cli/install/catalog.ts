/**
 * CLI-facing install catalog — re-exports shared host IDs and adds parseHostList.
 */

import { detectInstalledHosts } from "./detect.js";
import {
  HOST_ALIASES,
  HOST_IDS,
  HOST_NEXT_STEPS,
  IDE_ALIASES,
  IDE_NEXT_STEPS,
  INSTALL_HOST_PLATFORM_SOURCES,
  SUPPORTED_HOSTS,
  SUPPORTED_IDES,
  type HostId,
  type InstallHost,
  type InstallIde,
} from "../../shared/hosts.js";

export type { HostId, InstallHost, InstallIde };
export {
  HOST_ALIASES,
  HOST_IDS,
  HOST_NEXT_STEPS,
  IDE_ALIASES,
  IDE_NEXT_STEPS,
  INSTALL_HOST_PLATFORM_SOURCES,
  SUPPORTED_HOSTS,
  SUPPORTED_IDES,
};

export function resolveHostAlias(raw: string): string {
  return HOST_ALIASES[raw] ?? raw;
}

/** @deprecated Use `resolveHostAlias`. */
export const resolveIdeAlias = resolveHostAlias;

export function parseHostList(raw: string | undefined): InstallHost[] {
  if (!raw || !raw.trim()) {
    throw new Error(
      `Missing --host / --ide. Use one of: ${SUPPORTED_HOSTS.join(", ")}, all, or auto`
    );
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "all") return [...SUPPORTED_HOSTS];
  if (normalized === "auto") {
    const detected = detectInstalledHosts();
    if (detected.length === 0) {
      throw new Error(
        "No coding-agent hosts detected under your home directory. Pass --host / --ide explicitly."
      );
    }
    return detected;
  }

  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const out: InstallHost[] = [];
  for (const part of parts) {
    if (part === "auto" || part === "all") {
      throw new Error(`Use --host / --ide ${part} alone, not mixed with other values`);
    }
    const aliased = resolveHostAlias(part);
    if (!SUPPORTED_HOSTS.includes(aliased as InstallHost)) {
      throw new Error(
        `Unknown host "${part}". Supported: ${SUPPORTED_HOSTS.join(", ")}, all, auto`
      );
    }
    if (!out.includes(aliased as InstallHost)) out.push(aliased as InstallHost);
  }
  return out;
}

/** @deprecated Use `parseHostList`. */
export const parseIdeList = parseHostList;
