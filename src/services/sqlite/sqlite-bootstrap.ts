/**
 * SQLite Bootstrap Module
 *
 * This module MUST be imported before any other module that uses bun:sqlite.
 * It ensures that setCustomSQLite() is called BEFORE the Database class is
 * instantiated, which is required for custom SQLite paths to work on macOS.
 *
 * Issue: https://github.com/tickernelz/opencode-mem/issues/34
 *
 * Loading priority:
 * 1. Bundled dylib (native/darwin-{arch}/libsqlite3.dylib)
 * 2. Homebrew SQLite (auto-detected common paths)
 * 3. Custom path from config (customSqlitePath)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsoncComments } from "../jsonc.js";

let Database: typeof import("bun:sqlite").Database;
let sqliteConfigured = false;
let sqliteSource: string | null = null;

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILES = [
  join(CONFIG_DIR, "opencode-mem.jsonc"),
  join(CONFIG_DIR, "opencode-mem.json"),
];

interface SqliteConfig {
  customSqlitePath?: string;
}

function getBundledSqlitePath(): string | null {
  if (process.platform !== "darwin") return null;

  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") return null;

  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const bundledPath = join(
      currentDir,
      "..",
      "..",
      "..",
      "native",
      `darwin-${arch}`,
      "libsqlite3.dylib"
    );

    if (existsSync(bundledPath)) {
      return bundledPath;
    }
  } catch {}

  return null;
}

function loadSqliteConfig(): SqliteConfig {
  for (const path of CONFIG_FILES) {
    if (existsSync(path)) {
      try {
        const content = require("node:fs").readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        return JSON.parse(json) as SqliteConfig;
      } catch {}
    }
  }
  return {};
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

function getHomebrewSqlitePath(): string | null {
  const arch = process.arch;

  const paths =
    arch === "arm64"
      ? ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"]
      : [
          "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
          "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

export function configureSqlite(): void {
  if (sqliteConfigured) return;

  const bunSqlite = require("bun:sqlite") as typeof import("bun:sqlite");
  Database = bunSqlite.Database;

  if (process.platform !== "darwin") {
    sqliteConfigured = true;
    return;
  }

  const config = loadSqliteConfig();
  const customPath = config.customSqlitePath ? expandPath(config.customSqlitePath) : undefined;

  const trySetCustomSQLite = (path: string, source: string): boolean => {
    try {
      Database.setCustomSQLite(path);
      sqliteSource = source;
      return true;
    } catch (error) {
      const errorStr = String(error);
      if (errorStr.includes("SQLite already loaded")) {
        return true;
      }
      return false;
    }
  };

  // Priority 1: Bundled dylib
  const bundledPath = getBundledSqlitePath();
  if (bundledPath) {
    if (trySetCustomSQLite(bundledPath, "bundled")) {
      sqliteConfigured = true;
      return;
    }
  }

  // Priority 2: Custom path from config
  if (customPath) {
    if (!existsSync(customPath)) {
      throw new Error(
        `Custom SQLite library not found at: ${customPath}\n` +
          `Please verify the path or install Homebrew SQLite:\n` +
          `  brew install sqlite\n` +
          `  brew --prefix sqlite`
      );
    }

    if (trySetCustomSQLite(customPath, "custom")) {
      sqliteConfigured = true;
      return;
    }
  }

  // Priority 3: Homebrew SQLite
  const homebrewPath = getHomebrewSqlitePath();
  if (homebrewPath) {
    if (trySetCustomSQLite(homebrewPath, "homebrew")) {
      sqliteConfigured = true;
      return;
    }
  }

  // No compatible SQLite found
  throw new Error(
    `macOS detected but no compatible SQLite library found.\n\n` +
      `Apple's default SQLite does not support extension loading.\n` +
      `Solutions:\n\n` +
      `Option 1 - Install Homebrew SQLite (recommended):\n` +
      `  brew install sqlite\n\n` +
      `Option 2 - Download manually and configure:\n` +
      `  1. Download SQLite with extension support\n` +
      `  2. Add to ~/.config/opencode/opencode-mem.jsonc:\n` +
      `     {\n` +
      `       "customSqlitePath": "/path/to/libsqlite3.dylib"\n` +
      `     }\n\n` +
      `Common Homebrew paths:\n` +
      `  - Apple Silicon: /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib\n` +
      `  - Intel Mac:     /usr/local/opt/sqlite/lib/libsqlite3.dylib`
  );
}

export function getDatabase(): typeof import("bun:sqlite").Database {
  configureSqlite();
  return Database;
}

export function getSqliteSource(): string | null {
  return sqliteSource;
}

configureSqlite();
