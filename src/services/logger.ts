import { appendFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_DIR = join(homedir(), ".opencode-mem");
const LOG_FILE = join(LOG_DIR, "opencode-mem.log");

const GLOBAL_LOGGER_KEY = Symbol.for("opencode-mem.logger.initialized");

function ensureLoggerInitialized() {
  if ((globalThis as any)[GLOBAL_LOGGER_KEY]) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  writeFileSync(LOG_FILE, `\n--- Session started: ${new Date().toISOString()} ---\n`, { flag: "a" });
  (globalThis as any)[GLOBAL_LOGGER_KEY] = true;
}

export function log(message: string, data?: unknown) {
  ensureLoggerInitialized();
  const timestamp = new Date().toISOString();
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  appendFileSync(LOG_FILE, line);
}
