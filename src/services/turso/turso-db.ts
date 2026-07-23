import type { Client, InArgs, InValue, ResultSet, Transaction } from "@libsql/client";

type Row = Record<string, unknown>;

export class TursoDb {
  constructor(private readonly client: Client) {}

  getClient(): Client {
    return this.client;
  }

  async execute(sql: string, args?: InArgs): Promise<ResultSet> {
    return this.client.execute({ sql, args: args ?? [] });
  }

  async batch(statements: Array<{ sql: string; args?: InArgs }>, mode: "write" | "read" = "write") {
    return this.client.batch(
      statements.map((statement) => ({
        sql: statement.sql,
        args: statement.args ?? [],
      })),
      mode
    );
  }

  async get<T extends Row = Row>(sql: string, args?: InArgs): Promise<T | null> {
    const result = await this.execute(sql, args);
    return (result.rows[0] as T | undefined) ?? null;
  }

  async all<T extends Row = Row>(sql: string, args?: InArgs): Promise<T[]> {
    const result = await this.execute(sql, args);
    return result.rows as unknown as T[];
  }

  async run(sql: string, args?: InArgs): Promise<number> {
    const result = await this.execute(sql, args);
    return Number(result.rowsAffected ?? 0);
  }

  async transaction<T>(mode: "write" | "read", fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.client.transaction(mode);
    try {
      const value = await fn(tx);
      await tx.commit();
      return value;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // ignore rollback errors after a failed statement / already-closed tx
      }
      throw error;
    } finally {
      tx.close();
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
