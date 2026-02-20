/**
 * SQLite Bootstrap Module
 *
 * This module MUST be imported before any other module that uses bun:sqlite.
 * It ensures that setCustomSQLite() is called BEFORE the Database class is
 * instantiated, which is required for custom SQLite paths to work on macOS.
 *
 * Issue: https://github.com/tickernelz/opencode-mem/issues/34
 * Issue: https://github.com/tickernelz/opencode-mem/issues/37
 *
 * Loading priority:
 * 1. Bundled dylib (native/darwin-{arch}/libsqlite3.dylib)
 * 2. Homebrew SQLite (auto-detected common paths)
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let Database: typeof import("bun:sqlite").Database;
let sqliteConfigured = false;
let sqliteSource: string | null = null;

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

  const bundledPath = getBundledSqlitePath();
  if (bundledPath) {
    if (trySetCustomSQLite(bundledPath, "bundled")) {
      sqliteConfigured = true;
      return;
    }
  }

  const homebrewPath = getHomebrewSqlitePath();
  if (homebrewPath) {
    if (trySetCustomSQLite(homebrewPath, "homebrew")) {
      sqliteConfigured = true;
      return;
    }
  }

  throw new Error(
    `macOS detected but no compatible SQLite library found.\n\n` +
      `Apple's default SQLite does not support extension loading.\n` +
      `Solution:\n\n` +
      `Install Homebrew SQLite:\n` +
      `  brew install sqlite\n\n` +
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
