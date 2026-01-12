import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_DIR = join(homedir(), ".opencode-mem");
const LOG_FILE = join(LOG_DIR, "opencode-mem.log");

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

writeFileSync(LOG_FILE, `\n--- Session started: ${new Date().toISOString()} ---\n`, { flag: "a" });

export function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  appendFileSync(LOG_FILE, line);
}
