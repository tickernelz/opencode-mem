import type { Database } from "@tursodatabase/database";
import { safeLog } from "../logger.js";

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

/**
 * Upper bound for the pre-close WAL checkpoint. The host SIGTERMs and SIGKILLs
 * the service after ~5s, so a checkpoint that cannot finish (another process
 * holds a read lock) must not eat the whole shutdown budget.
 */
const CHECKPOINT_TIMEOUT_MS = 1500;

export class TursoDb {
  constructor(
    private readonly database: Database,
    private readonly checkpointTimeoutMs: number = CHECKPOINT_TIMEOUT_MS
  ) {}

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

  /**
   * Checkpoint the WAL into the main DB before closing so a SIGKILL during
   * teardown cannot leave a 0-byte `-wal` beside a stale `-tshm` (every later
   * open then fails with "short read on WAL frame"). Never throws: a busy or
   * slow checkpoint is logged and skipped.
   *
   * The timeout only bounds how long we *prefer* to wait before logging a
   * failure — turso's `close()` does not take `execLock`, so we must still
   * await settlement of the pragma before returning. Closing under an
   * in-flight statement would recreate the tear this helper exists to avoid.
   * A truncate stuck on a foreign reader can therefore still hold shutdown
   * past the bound until the reader leaves (or the host SIGKILLs).
   */
  private async checkpointBeforeClose(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkpoint = this.database.all("PRAGMA wal_checkpoint(TRUNCATE)");
    try {
      const rows = await Promise.race([
        checkpoint,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${this.checkpointTimeoutMs}ms`)),
            this.checkpointTimeoutMs
          );
        }),
      ]);
      // `PRAGMA wal_checkpoint` returns {busy, log, checkpointed}; busy>0 means a
      // reader blocked the truncate and the WAL was only partially checkpointed.
      const result = Array.isArray(rows) ? rows[0] : undefined;
      safeLog("Turso WAL checkpoint before close", {
        busy: result?.busy,
        log: result?.log,
        checkpointed: result?.checkpointed,
      });
    } catch (error) {
      safeLog("Turso WAL checkpoint before close failed", { error: String(error) });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Always drain the pragma before close(), including after a timeout win:
      // a late rejection must not escape unhandled, and the native close must
      // not race an in-flight statement on the same handle.
      await checkpoint.catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.checkpointBeforeClose();
    await this.database.close();
  }

  /**
   * Close without the WAL checkpoint, for the synchronous `exit` handler where
   * async continuations never run. The turso async `close()` calls the native
   * close in its first statement with nothing awaited before it, so an
   * un-awaited call really does release the handle — but it leaves the `-wal`
   * in place, which is unavoidable without an event loop.
   */
  closeSync(): void {
    // Errors surface as a rejected promise (never a throw) and are ignored:
    // the process is exiting and there is no budget left to act on them.
    void this.database.close().catch(() => {});
  }
}
