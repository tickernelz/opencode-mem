/**
 * Database adapter factory
 */

import type { IDatabaseAdapter } from "./interfaces.js";
import type { DatabaseConfig } from "./types.js";

let cachedAdapter: IDatabaseAdapter | null = null;

/**
 * Factory for creating database adapters
 */
export class DatabaseFactory {
  /**
   * Create a database adapter based on configuration
   */
  static async create(config: DatabaseConfig): Promise<IDatabaseAdapter> {
    if (cachedAdapter) {
      return cachedAdapter;
    }

    let adapter: IDatabaseAdapter;

    if (config.databaseType === "postgresql") {
      const { PostgresAdapter } = await import("./postgres/adapter.js");
      adapter = new PostgresAdapter(config);
    } else {
      const { SQLiteAdapter } = await import("./sqlite/adapter.js");
      adapter = new SQLiteAdapter(config);
    }

    await adapter.initialize();
    cachedAdapter = adapter;

    return adapter;
  }

  /**
   * Get the cached adapter instance
   */
  static getCached(): IDatabaseAdapter | null {
    return cachedAdapter;
  }

  /**
   * Close and clear the cached adapter
   */
  static async close(): Promise<void> {
    if (cachedAdapter) {
      await cachedAdapter.close();
      cachedAdapter = null;
    }
  }
}
