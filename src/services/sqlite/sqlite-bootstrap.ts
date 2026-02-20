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
 * The bundled dylib has sqlite-vec statically linked, so no extension loading needed.
 * Loading priority:
 * 1. Bundled dylib (native/darwin-{arch}/libsqlite3.dylib) - includes sqlite-vec
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

function checkSqliteVec(db: typeof Database.prototype): boolean {
  try {
    const result = db.prepare("SELECT vec_version()").all() as any[];
    return result && result.length > 0;
  } catch {
    return false;
  }
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
        sqliteSource = "already-loaded";
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
      `The bundled SQLite dylib with sqlite-vec is required.\n` +
      `Try reinstalling opencode-mem.`
  );
}

export function getDatabase(): typeof import("bun:sqlite").Database {
  configureSqlite();
  return Database;
}

export function getSqliteSource(): string | null {
  return sqliteSource;
}

export function verifySqliteVec(): void {
  const db = new Database(":memory:");
  if (!checkSqliteVec(db)) {
    db.close();
    throw new Error(
      `sqlite-vec extension not available.\n\n` +
        `This plugin requires SQLite with sqlite-vec built-in.\n` +
        `The bundled dylib should have sqlite-vec statically linked.\n` +
        `Try reinstalling opencode-mem.`
    );
  }
  db.close();
}

configureSqlite();
verifySqliteVec();
