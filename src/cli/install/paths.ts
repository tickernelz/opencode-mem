import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { copilotCliMcpPathForHome, vscodeUserMcpPathForHome } from "../../shared/hosts.js";
import type { InstallHost } from "./catalog.js";
import type { InstallResult } from "./types.js";

/** Prefer HOME/USERPROFILE so tests and custom environments can redirect writes. */
export function resolveUserHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function resolveProjectDir(projectDir?: string): string | undefined {
  if (!projectDir) return undefined;
  return isAbsolute(projectDir) ? projectDir : resolve(projectDir);
}

export function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function fileAction(before: string, after: string): InstallResult["action"] {
  if (!before) return "created";
  if (before === after) return "unchanged";
  return "updated";
}

export function combineActions(actions: Array<InstallResult["action"]>): InstallResult["action"] {
  if (actions.some((a) => a === "created") && actions.every((a) => a === "created")) {
    return "created";
  }
  if (actions.every((a) => a === "unchanged")) return "unchanged";
  if (actions.some((a) => a === "created" || a === "updated")) return "updated";
  return "unchanged";
}

export function multiPathResult(
  host: InstallHost,
  primary: InstallResult,
  extras: InstallResult[]
): InstallResult {
  const also = [...(primary.also ?? []), ...extras.map((e) => e.path)];
  const uniqueAlso = [...new Set(also)];
  const baseDetail = primary.detail.split("; also ")[0] ?? primary.detail;
  return {
    host,
    path: primary.path,
    action: combineActions([primary.action, ...extras.map((e) => e.action)]),
    detail: uniqueAlso.length === 0 ? baseDetail : `${baseDetail}; also ${uniqueAlso.join(", ")}`,
    also: uniqueAlso.length > 0 ? uniqueAlso : undefined,
  };
}

export function vscodeUserMcpPath(): string {
  return vscodeUserMcpPathForHome(resolveUserHome());
}

export function copilotCliMcpPath(): string {
  return copilotCliMcpPathForHome(resolveUserHome());
}
