/**
 * SQLite Bootstrap Module
 *
 * This module MUST be imported before any other module that uses bun:sqlite.
 * It ensures that setCustomSQLite() is called BEFORE the Database class is
 * instantiated, which is required for custom SQLite paths to work on macOS.
 *
 * Issue: https://github.com/tickernelz/opencode-mem/issues/34
 *
 * The problem: `import { Database } from "bun:sqlite"` at the top of a file
 * causes SQLite to be loaded immediately. By the time setCustomSQLite() is
 * called, it's too late - SQLite is already loaded with Apple's default SQLite
 * which doesn't support extension loading.
 *
 * Solution: This module uses dynamic require() to load bun:sqlite AFTER
 * reading the config and calling setCustomSQLite(). All other modules should
 * import Database from this module using getDatabase() instead of directly
 * from bun:sqlite.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripJsoncComments } from "../jsonc.js";

let Database: typeof import("bun:sqlite").Database;
let sqliteConfigured = false;

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const CONFIG_FILES = [
  join(CONFIG_DIR, "opencode-mem.jsonc"),
  join(CONFIG_DIR, "opencode-mem.json"),
];

interface SqliteConfig {
  customSqlitePath?: string;
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

export function configureSqlite(): void {
  if (sqliteConfigured) return;

  const config = loadSqliteConfig();
  const customPath = config.customSqlitePath ? expandPath(config.customSqlitePath) : undefined;

  const bunSqlite = require("bun:sqlite") as typeof import("bun:sqlite");
  Database = bunSqlite.Database;

  if (process.platform === "darwin") {
    if (customPath) {
      if (!existsSync(customPath)) {
        throw new Error(
          `Custom SQLite library not found at: ${customPath}\n` +
            `Please verify the path or install Homebrew SQLite:\n` +
            `  brew install sqlite\n` +
            `  brew --prefix sqlite`
        );
      }

      try {
        Database.setCustomSQLite(customPath);
      } catch (error) {
        const errorStr = String(error);
        if (!errorStr.includes("SQLite already loaded")) {
          throw new Error(
            `Failed to load custom SQLite library: ${error}\n` + `Path: ${customPath}`
          );
        }
      }
    } else {
      const commonPaths = [
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      ];

      let foundPath: string | null = null;
      for (const path of commonPaths) {
        if (existsSync(path)) {
          foundPath = path;
          break;
        }
      }

      if (foundPath) {
        try {
          Database.setCustomSQLite(foundPath);
        } catch (error) {
          const errorStr = String(error);
          if (!errorStr.includes("SQLite already loaded")) {
            throw new Error(`Failed to load Homebrew SQLite: ${error}\n` + `Path: ${foundPath}`);
          }
        }
      } else {
        throw new Error(
          `macOS detected but no compatible SQLite library found.\n\n` +
            `Apple's default SQLite does not support extension loading.\n` +
            `Please install Homebrew SQLite and configure the path:\n\n` +
            `1. Install Homebrew SQLite:\n` +
            `   brew install sqlite\n\n` +
            `2. Find the library path:\n` +
            `   brew --prefix sqlite\n\n` +
            `3. Add to ~/.config/opencode/opencode-mem.jsonc:\n` +
            `   {\n` +
            `     "customSqlitePath": "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"\n` +
            `   }\n\n` +
            `Common paths:\n` +
            `  - Apple Silicon: /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib\n` +
            `  - Intel Mac:     /usr/local/opt/sqlite/lib/libsqlite3.dylib`
        );
      }
    }
  }

  sqliteConfigured = true;
}

export function getDatabase(): typeof import("bun:sqlite").Database {
  configureSqlite();
  return Database;
}

configureSqlite();
