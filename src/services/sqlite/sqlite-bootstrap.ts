import { Database as BunDatabase } from "bun:sqlite";

export function getDatabase(): typeof BunDatabase {
  return BunDatabase;
}
