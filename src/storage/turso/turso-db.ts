import type { Database } from "@tursodatabase/database";

export type SqlValue = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer;
export type SqlArgs = SqlValue[] | Record<string, SqlValue>;

export interface ResultSet {
  columns: string[];
  columnTypes: string[];
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
  lastInsertRowid?: number | bigint;
}

type BatchResultLike = {
  columns?: string[];
  columnTypes?: string[];
  rows?: Array<Record<string, unknown> | unknown[]>;
  rowsAffected?: number;
  lastInsertRowid?: number;
};

type Row = Record<string, unknown>;

function isReadQuery(sql: string): boolean {
  return /^\s*(SELECT|WITH)\b/i.test(sql) || /^\s*PRAGMA\s+[^=;]+$/i.test(sql.trim());
}

function normalizeArgs(args?: SqlArgs): SqlValue[] | Record<string, SqlValue> {
  if (!args) return [];
  return args;
}

function toResultSet(result: BatchResultLike): ResultSet {
  return {
    columns: result.columns ?? [],
    columnTypes: result.columnTypes ?? [],
    rows: (result.rows ?? []) as Array<Record<string, unknown>>,
    rowsAffected: Number(result.rowsAffected ?? 0),
    lastInsertRowid: result.lastInsertRowid,
  };
}

function statementToResultSet(
  rows: Array<Record<string, unknown>>,
  rowsAffected = 0,
  lastInsertRowid?: number | bigint
): ResultSet {
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return {
    columns,
    columnTypes: columns.map(() => ""),
    rows,
    rowsAffected,
    lastInsertRowid,
  };
}

/** Minimal transaction handle used by vector insert / API update paths. */
export interface TursoTx {
  execute(statement: { sql: string; args?: SqlArgs } | string, args?: SqlArgs): Promise<ResultSet>;
  run(sql: string, args?: SqlArgs): Promise<number>;
  get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null>;
  all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]>;
}

class TursoTxAdapter implements TursoTx {
  constructor(
    private readonly runSql: (
      sql: string,
      args?: SqlArgs
    ) => Promise<{ changes: number; lastInsertRowid: number }>,
    private readonly getSql: (sql: string, args?: SqlArgs) => Promise<Row | undefined>,
    private readonly allSql: (sql: string, args?: SqlArgs) => Promise<Row[]>
  ) {}

  async execute(
    statement: { sql: string; args?: SqlArgs } | string,
    args?: SqlArgs
  ): Promise<ResultSet> {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const bind = typeof statement === "string" ? args : statement.args;
    const normalized = normalizeArgs(bind);
    const isSelect = isReadQuery(sql);
    if (isSelect) {
      const rows = await this.allSql(sql, normalized);
      return statementToResultSet(rows);
    }
    const info = Array.isArray(normalized)
      ? await this.runSql(sql, normalized)
      : await this.runSql(sql, normalized);
    return statementToResultSet([], Number(info.changes ?? 0), info.lastInsertRowid);
  }

  async run(sql: string, args?: SqlArgs): Promise<number> {
    const info = await this.runSql(sql, normalizeArgs(args));
    return Number(info.changes ?? 0);
  }

  async get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null> {
    const row = await this.getSql(sql, normalizeArgs(args));
    return (row as T | undefined) ?? null;
  }

  async all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]> {
    return (await this.allSql(sql, normalizeArgs(args))) as T[];
  }
}

function bindArgs(args?: SqlArgs): SqlValue[] | [Record<string, SqlValue>] {
  const normalized = normalizeArgs(args);
  if (Array.isArray(normalized)) return normalized;
  return [normalized];
}

export class TursoDb {
  constructor(private readonly database: Database) {}

  getClient(): Database {
    return this.database;
  }

  async execute(sql: string, args?: SqlArgs): Promise<ResultSet> {
    const normalized = normalizeArgs(args);
    if (isReadQuery(sql)) {
      const rows = Array.isArray(normalized)
        ? ((await this.database.all(sql, ...normalized)) as Row[])
        : ((await this.database.all(sql, normalized)) as Row[]);
      return statementToResultSet(rows);
    }
    const info = Array.isArray(normalized)
      ? await this.database.run(sql, ...normalized)
      : await this.database.run(sql, normalized);
    return statementToResultSet([], Number(info.changes ?? 0), info.lastInsertRowid);
  }

  async batch(
    statements: Array<{ sql: string; args?: SqlArgs }>,
    mode: "write" | "read" = "write"
  ): Promise<ResultSet[]> {
    const batchMode = mode === "read" ? "deferred" : "immediate";
    const results = await this.database.batch(
      statements.map((statement) => ({
        sql: statement.sql,
        args: normalizeArgs(statement.args),
      })),
      batchMode
    );
    return results.map(toResultSet);
  }

  async get<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T | null> {
    const normalized = normalizeArgs(args);
    const row = Array.isArray(normalized)
      ? await this.database.get(sql, ...normalized)
      : await this.database.get(sql, normalized);
    return (row as T | undefined) ?? null;
  }

  async all<T extends Row = Row>(sql: string, args?: SqlArgs): Promise<T[]> {
    const normalized = normalizeArgs(args);
    const rows = Array.isArray(normalized)
      ? await this.database.all(sql, ...normalized)
      : await this.database.all(sql, normalized);
    return rows as T[];
  }

  async run(sql: string, args?: SqlArgs): Promise<number> {
    const normalized = normalizeArgs(args);
    const info = Array.isArray(normalized)
      ? await this.database.run(sql, ...normalized)
      : await this.database.run(sql, normalized);
    return Number(info.changes ?? 0);
  }

  async transaction<T>(mode: "write" | "read", fn: (tx: TursoTx) => Promise<T>): Promise<T> {
    const txnMode = mode === "read" ? "deferred" : "immediate";
    const wrapped = this.database.transactionAsync(async (nativeTx) => {
      const adapter = new TursoTxAdapter(
        async (sql, args) => {
          const bind = bindArgs(args);
          if (Array.isArray(bind) && bind.length === 1 && !Array.isArray(args) && args) {
            return nativeTx.run(sql, bind[0]);
          }
          return nativeTx.run(sql, ...(bind as SqlValue[]));
        },
        async (sql, args) => {
          const bind = bindArgs(args);
          if (Array.isArray(bind) && bind.length === 1 && !Array.isArray(args) && args) {
            return nativeTx.get(sql, bind[0]);
          }
          return nativeTx.get(sql, ...(bind as SqlValue[]));
        },
        async (sql, args) => {
          const bind = bindArgs(args);
          if (Array.isArray(bind) && bind.length === 1 && !Array.isArray(args) && args) {
            return nativeTx.all(sql, bind[0]);
          }
          return nativeTx.all(sql, ...(bind as SqlValue[]));
        }
      );
      return fn(adapter);
    });
    return wrapped[txnMode]();
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
