import { createRequire } from "module";
const require = createRequire(import.meta.url);

let _Database: any;

function buildNodeCompat(): any {
  const { DatabaseSync } = require("node:sqlite");
  return class NodeDatabase {
    private _db: any;
    constructor(path: string) {
      this._db = new DatabaseSync(path);
    }
    run(sql: string, ...params: any[]) {
      return this._db.prepare(sql).run(...params);
    }
    prepare(sql: string) {
      return this._db.prepare(sql);
    }
    close() {
      this._db.close();
    }
    query(sql: string) {
      return this._db.prepare(sql);
    }
  };
}

export function getDatabase(): any {
  if (!_Database) {
    try {
      const { Database } = require("bun:sqlite");
      _Database = Database;
    } catch {
      _Database = buildNodeCompat();
    }
  }
  return _Database;
}
