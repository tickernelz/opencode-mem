import type {
  AISession,
  SessionCreateParams,
  SessionUpdateParams,
  AIProviderType,
  AIMessage,
} from "./session-types.js";
import { CONFIG } from "../../../config.js";

const AI_SESSIONS_DB_NAME = "ai-sessions.db";

export class AISessionManager {
  private readonly sessionRetentionMs: number;

  constructor() {
    this.sessionRetentionMs = CONFIG.aiSessionRetentionDays * 24 * 60 * 60 * 1000;
    if (CONFIG.databaseType === "sqlite") {
      this.initDatabaseSQLite();
    }
  }

  private initDatabaseSQLite(): void {
    const { join } = require("node:path");
    const { Database } = require("bun:sqlite");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);

    // Import dynamically to avoid loading SQLite connection manager when using PostgreSQL
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    db.run(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_id ON ai_sessions(session_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires_at ON ai_sessions(expires_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider ON ai_sessions(provider)");

    db.run(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ai_session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        content_blocks TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (ai_session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
      )
    `);

    db.run(
      "CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(ai_session_id, sequence)"
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_ai_messages_role ON ai_messages(ai_session_id, role)"
    );
  }

  async getSession(sessionId: string, provider: AIProviderType): Promise<AISession | null> {
    if (CONFIG.databaseType === "sqlite") {
      return this.getSessionSQLite(sessionId, provider);
    } else {
      return this.getSessionPostgreSQL(sessionId, provider);
    }
  }

  private getSessionSQLite(sessionId: string, provider: AIProviderType): AISession | null {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    const stmt = db.prepare(`
      SELECT * FROM ai_sessions
      WHERE session_id = ? AND provider = ? AND expires_at > ?
    `);
    const row = stmt.get(sessionId, provider, Date.now()) as any;

    if (!row) return null;

    return this.rowToSession(row);
  }

  private async getSessionPostgreSQL(sessionId: string, provider: AIProviderType): Promise<AISession | null> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    const result = await pool.query(
      `SELECT * FROM ai_sessions
       WHERE session_id = $1 AND provider = $2 AND expires_at > NOW()`,
      [sessionId, provider]
    );

    if (result.rows.length === 0) return null;

    return this.rowToSessionPostgreSQL(result.rows[0]);
  }

  async createSession(params: SessionCreateParams): Promise<AISession> {
    if (CONFIG.databaseType === "sqlite") {
      return this.createSessionSQLite(params);
    } else {
      return this.createSessionPostgreSQL(params);
    }
  }

  private createSessionSQLite(params: SessionCreateParams): AISession {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    const expiresAt = now + this.sessionRetentionMs;

    db.run(
      `INSERT INTO ai_sessions (
        id, provider, session_id, conversation_id,
        metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        params.provider,
        params.sessionId,
        params.conversationId || null,
        JSON.stringify(params.metadata || {}),
        now,
        now,
        expiresAt,
      ]
    );

    return this.getSessionSQLite(params.sessionId, params.provider)!;
  }

  private async createSessionPostgreSQL(params: SessionCreateParams): Promise<AISession> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionRetentionMs);

    await pool.query(
      `INSERT INTO ai_sessions (
        id, provider, session_id, conversation_id,
        metadata, created_at, updated_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        params.provider,
        params.sessionId,
        params.conversationId || null,
        JSON.stringify(params.metadata || {}),
        now,
        now,
        expiresAt,
      ]
    );

    return (await this.getSessionPostgreSQL(params.sessionId, params.provider))!;
  }

  async updateSession(sessionId: string, provider: AIProviderType, updates: SessionUpdateParams): Promise<void> {
    if (CONFIG.databaseType === "sqlite") {
      this.updateSessionSQLite(sessionId, provider, updates);
    } else {
      await this.updateSessionPostgreSQL(sessionId, provider, updates);
    }
  }

  private updateSessionSQLite(sessionId: string, provider: AIProviderType, updates: SessionUpdateParams): void {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.conversationId !== undefined) {
      fields.push("conversation_id = ?");
      values.push(updates.conversationId);
    }

    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }

    fields.push("updated_at = ?");
    values.push(Date.now());

    values.push(sessionId);
    values.push(provider);

    db.run(
      `UPDATE ai_sessions
       SET ${fields.join(", ")}
       WHERE session_id = ? AND provider = ?`,
      values
    );
  }

  private async updateSessionPostgreSQL(sessionId: string, provider: AIProviderType, updates: SessionUpdateParams): Promise<void> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.conversationId !== undefined) {
      fields.push(`conversation_id = $${paramIndex++}`);
      values.push(updates.conversationId);
    }

    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    fields.push(`updated_at = $${paramIndex++}`);
    values.push(new Date());

    values.push(sessionId);
    values.push(provider);

    await pool.query(
      `UPDATE ai_sessions
       SET ${fields.join(", ")}
       WHERE session_id = $${paramIndex++} AND provider = $${paramIndex++}`,
      values
    );
  }

  async cleanupExpiredSessions(): Promise<number> {
    if (CONFIG.databaseType === "sqlite") {
      return this.cleanupExpiredSessionsSQLite();
    } else {
      return this.cleanupExpiredSessionsPostgreSQL();
    }
  }

  private cleanupExpiredSessionsSQLite(): number {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    const result = db.run(`DELETE FROM ai_sessions WHERE expires_at < ?`, [Date.now()]);
    return result.changes;
  }

  private async cleanupExpiredSessionsPostgreSQL(): Promise<number> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    const result = await pool.query(`DELETE FROM ai_sessions WHERE expires_at < NOW()`);
    return result.rowCount || 0;
  }

  async deleteSession(sessionId: string, provider: AIProviderType): Promise<void> {
    if (CONFIG.databaseType === "sqlite") {
      this.deleteSessionSQLite(sessionId, provider);
    } else {
      await this.deleteSessionPostgreSQL(sessionId, provider);
    }
  }

  private deleteSessionSQLite(sessionId: string, provider: AIProviderType): void {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    db.run(`DELETE FROM ai_sessions WHERE session_id = ? AND provider = ?`, [sessionId, provider]);
  }

  private async deleteSessionPostgreSQL(sessionId: string, provider: AIProviderType): Promise<void> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    await pool.query(`DELETE FROM ai_sessions WHERE session_id = $1 AND provider = $2`, [sessionId, provider]);
  }

  async addMessage(message: Omit<AIMessage, "id" | "createdAt">): Promise<void> {
    if (CONFIG.databaseType === "sqlite") {
      this.addMessageSQLite(message);
    } else {
      await this.addMessagePostgreSQL(message);
    }
  }

  private addMessageSQLite(message: Omit<AIMessage, "id" | "createdAt">): void {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    db.run(
      `INSERT INTO ai_messages (
        ai_session_id, sequence, role, content,
        tool_calls, tool_call_id, content_blocks, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.aiSessionId,
        message.sequence,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId || null,
        message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
        Date.now(),
      ]
    );
  }

  private async addMessagePostgreSQL(message: Omit<AIMessage, "id" | "createdAt">): Promise<void> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    await pool.query(
      `INSERT INTO ai_messages (
        ai_session_id, sequence, role, content,
        tool_calls, tool_call_id, content_blocks, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        message.aiSessionId,
        message.sequence,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId || null,
        message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
        new Date(),
      ]
    );
  }

  async getMessages(aiSessionId: string): Promise<AIMessage[]> {
    if (CONFIG.databaseType === "sqlite") {
      return this.getMessagesSQLite(aiSessionId);
    } else {
      return this.getMessagesPostgreSQL(aiSessionId);
    }
  }

  private getMessagesSQLite(aiSessionId: string): AIMessage[] {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    const stmt = db.prepare(
      "SELECT * FROM ai_messages WHERE ai_session_id = ? ORDER BY sequence ASC"
    );
    const rows = stmt.all(aiSessionId) as any[];

    return rows.map(this.rowToMessage);
  }

  private async getMessagesPostgreSQL(aiSessionId: string): Promise<AIMessage[]> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    const result = await pool.query(
      "SELECT * FROM ai_messages WHERE ai_session_id = $1 ORDER BY sequence ASC",
      [aiSessionId]
    );

    return result.rows.map(this.rowToMessagePostgreSQL);
  }

  async getLastSequence(aiSessionId: string): Promise<number> {
    if (CONFIG.databaseType === "sqlite") {
      return this.getLastSequenceSQLite(aiSessionId);
    } else {
      return this.getLastSequencePostgreSQL(aiSessionId);
    }
  }

  private getLastSequenceSQLite(aiSessionId: string): number {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    const stmt = db.prepare(
      "SELECT MAX(sequence) as max_seq FROM ai_messages WHERE ai_session_id = ?"
    );
    const row = stmt.get(aiSessionId) as any;

    return row?.max_seq ?? -1;
  }

  private async getLastSequencePostgreSQL(aiSessionId: string): Promise<number> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    const result = await pool.query(
      "SELECT MAX(sequence) as max_seq FROM ai_messages WHERE ai_session_id = $1",
      [aiSessionId]
    );

    return result.rows[0]?.max_seq ?? -1;
  }

  async clearMessages(aiSessionId: string): Promise<void> {
    if (CONFIG.databaseType === "sqlite") {
      this.clearMessagesSQLite(aiSessionId);
    } else {
      await this.clearMessagesPostgreSQL(aiSessionId);
    }
  }

  private clearMessagesSQLite(aiSessionId: string): void {
    const { join } = require("node:path");
    const dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    const { connectionManager: sqliteConnectionManager } = require("../../database/sqlite/connection-manager.js");
    const db = sqliteConnectionManager.getConnection(dbPath);

    db.run("DELETE FROM ai_messages WHERE ai_session_id = ?", [aiSessionId]);
  }

  private async clearMessagesPostgreSQL(aiSessionId: string): Promise<void> {
    const { connectionManager: pgConnectionManager } = await import("../../database/postgres/connection-manager.js");
    const pool = await pgConnectionManager.getPool();

    await pool.query("DELETE FROM ai_messages WHERE ai_session_id = $1", [aiSessionId]);
  }

  private rowToSession(row: any): AISession {
    return {
      id: row.id,
      provider: row.provider as AIProviderType,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  private rowToSessionPostgreSQL(row: any): AISession {
    return {
      id: row.id,
      provider: row.provider as AIProviderType,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      metadata: row.metadata || undefined,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
    };
  }

  private rowToMessage(row: any): AIMessage {
    return {
      id: row.id,
      aiSessionId: row.ai_session_id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      toolCallId: row.tool_call_id,
      contentBlocks: row.content_blocks ? JSON.parse(row.content_blocks) : undefined,
      createdAt: row.created_at,
    };
  }

  private rowToMessagePostgreSQL(row: any): AIMessage {
    return {
      id: row.id,
      aiSessionId: row.ai_session_id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls || undefined,
      toolCallId: row.tool_call_id,
      contentBlocks: row.content_blocks || undefined,
      createdAt: new Date(row.created_at).getTime(),
    };
  }
}

export const aiSessionManager = new AISessionManager();
