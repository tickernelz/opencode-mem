let Database: typeof import("bun:sqlite").Database;

export function getDatabase(): typeof import("bun:sqlite").Database {
  if (!Database) {
    const bunSqlite = require("bun:sqlite") as typeof import("bun:sqlite");
    Database = bunSqlite.Database;
  }
  return Database;
}
