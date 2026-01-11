import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { AISession, SessionCreateParams, SessionUpdateParams, AIProviderType } from "./session-types.js";

export class SessionStore {
  private db: Database;
  private readonly sessionRetentionMs: number;

  constructor(storagePath: string, retentionDays: number = 7) {
    const dbDir = join(storagePath, "..");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = join(dbDir, "ai-sessions.db");
    this.db = new Database(dbPath);
    this.sessionRetentionMs = retentionDays * 24 * 60 * 60 * 1000;
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        last_response_id TEXT,
        message_history TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_id ON ai_sessions(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires_at ON ai_sessions(expires_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider ON ai_sessions(provider)");
  }

  getSession(sessionId: string, provider: AIProviderType): AISession | null {
    const row = this.db
      .query(`
        SELECT * FROM ai_sessions 
        WHERE session_id = ? AND provider = ? AND expires_at > ?
      `)
      .get(sessionId, provider, Date.now()) as any;

    if (!row) return null;

    return this.rowToSession(row);
  }

  createSession(params: SessionCreateParams): AISession {
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    const expiresAt = now + this.sessionRetentionMs;

    this.db.run(
      `
      INSERT INTO ai_sessions (
        id, provider, session_id, conversation_id, 
        metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
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

    return this.getSession(params.sessionId, params.provider)!;
  }

  updateSession(sessionId: string, provider: AIProviderType, updates: SessionUpdateParams): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.conversationId !== undefined) {
      fields.push("conversation_id = ?");
      values.push(updates.conversationId);
    }

    if (updates.lastResponseId !== undefined) {
      fields.push("last_response_id = ?");
      values.push(updates.lastResponseId);
    }

    if (updates.messageHistory !== undefined) {
      fields.push("message_history = ?");
      values.push(JSON.stringify(updates.messageHistory));
    }

    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }

    fields.push("updated_at = ?");
    values.push(Date.now());

    values.push(sessionId);
    values.push(provider);

    this.db.run(
      `
      UPDATE ai_sessions 
      SET ${fields.join(", ")}
      WHERE session_id = ? AND provider = ?
    `,
      values
    );
  }

  cleanupExpiredSessions(): number {
    const result = this.db.run(`DELETE FROM ai_sessions WHERE expires_at < ?`, [Date.now()]);
    return result.changes;
  }

  deleteSession(sessionId: string, provider: AIProviderType): void {
    this.db.run(`DELETE FROM ai_sessions WHERE session_id = ? AND provider = ?`, [sessionId, provider]);
  }

  close(): void {
    this.db.close();
  }

  private rowToSession(row: any): AISession {
    return {
      id: row.id,
      provider: row.provider as AIProviderType,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      lastResponseId: row.last_response_id,
      messageHistory: row.message_history ? JSON.parse(row.message_history) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }
}
