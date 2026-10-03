import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".opencode-mem");
export const RUNTIME_INFO_PATH = join(DATA_DIR, "runtime.json");

export interface RuntimeInfo {
  host: string;
  port: number;
  pid: number;
  url: string;
  startedAt: number;
}

export function writeRuntimeInfo(info: RuntimeInfo): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(RUNTIME_INFO_PATH, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function readRuntimeInfo(): RuntimeInfo | null {
  if (!existsSync(RUNTIME_INFO_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(RUNTIME_INFO_PATH, "utf-8")) as RuntimeInfo;
    if (
      typeof parsed?.host !== "string" ||
      typeof parsed?.port !== "number" ||
      typeof parsed?.url !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearRuntimeInfo(expectedPid?: number): void {
  const current = readRuntimeInfo();
  if (!current) return;
  if (expectedPid !== undefined && current.pid !== expectedPid) return;
  try {
    unlinkSync(RUNTIME_INFO_PATH);
  } catch {
    // best-effort
  }
}
