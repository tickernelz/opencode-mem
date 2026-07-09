import {
  appendFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

function getLogFilePath(): string {
  return process.env.OPENCODE_MEM_LOG_FILE || join(homedir(), ".opencode-mem", "opencode-mem.log");
}

function getLogDirPath(): string {
  const logFile = getLogFilePath();
  const lastSlash = Math.max(logFile.lastIndexOf("/"), logFile.lastIndexOf("\\"));
  return lastSlash === -1 ? "." : logFile.slice(0, lastSlash);
}

const MAX_LOG_SIZE = 5 * 1024 * 1024;
const MAX_LOG_DAYS = 30;

const GLOBAL_LOGGER_KEY = Symbol.for("opencode-mem.logger.initialized");
const LAST_ROTATE_DATE_KEY = Symbol.for("opencode-mem.logger.lastRotateDate");

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offset) / 60));
  const om = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDateStamp(): string {
  return formatDate(new Date());
}

function rotateLog() {
  const logFile = getLogFilePath();
  try {
    if (!existsSync(logFile)) return;

    const stats = statSync(logFile);
    const dateStamp = getDateStamp();
    const logDir = getLogDirPath();

    const needRotate = (() => {
      if (stats.size >= MAX_LOG_SIZE) return true;
      const lastModified = formatDate(stats.mtime);
      return dateStamp !== lastModified;
    })();

    if (!needRotate) return;

    const archiveName = join(logDir, `opencode-mem-${getArchiveDate(stats)}.log`);
    if (!existsSync(archiveName)) {
      renameSync(logFile, archiveName);
    } else {
      const oldLog = logFile + ".old";
      if (existsSync(oldLog)) unlinkSync(oldLog);
      renameSync(logFile, oldLog);
    }

    cleanupOldLogs();
  } catch {}
}

function getArchiveDate(stats: { mtime: Date }): string {
  return formatDate(stats.mtime);
}

function cleanupOldLogs() {
  const logDir = getLogDirPath();
  const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  try {
    if (!existsSync(logDir)) return;
    const files = readdirSync(logDir);
    for (const file of files) {
      const match = file.match(/^opencode-mem-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!match) continue;
      const dateStr = match[1]!;
      const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
      const fileDate = new Date(y, m - 1, d);
      if (fileDate.getTime() < cutoff) {
        unlinkSync(join(logDir, file));
      }
    }
  } catch {}
}

function ensureLoggerInitialized() {
  if ((globalThis as any)[GLOBAL_LOGGER_KEY]) return;
  const logDir = getLogDirPath();
  const logFile = getLogFilePath();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  rotateLog();
  writeFileSync(logFile, `\n--- Session started: ${formatTimestamp(new Date())} ---\n`, {
    flag: "a",
  });
  (globalThis as any)[GLOBAL_LOGGER_KEY] = true;
}

export function log(message: string, data?: unknown) {
  ensureLoggerInitialized();

  const today = formatDate(new Date());
  if ((globalThis as any)[LAST_ROTATE_DATE_KEY] !== today) {
    (globalThis as any)[LAST_ROTATE_DATE_KEY] = today;
    rotateLog();
  }

  const logFile = getLogFilePath();
  const timestamp = formatTimestamp(new Date());
  const line = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  appendFileSync(logFile, line);
}
