import type { InstallHost } from "./catalog.js";

export interface McpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface InstallResult {
  host: InstallHost;
  path: string;
  action: "created" | "updated" | "unchanged";
  detail: string;
  /** Extra config paths written for the same host (project-local, dual formats). */
  also?: string[];
}
