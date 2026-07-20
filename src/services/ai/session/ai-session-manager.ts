import { join } from "node:path";
import type {
  AISession,
  SessionCreateParams,
  SessionUpdateParams,
  AIProviderType,
  AIMessage,
} from "./session-types.js";
import { tursoConnectionManager } from "../../turso/connection-manager.js";
import { CONFIG } from "../../../config.js";
import type { InValue } from "@libsql/client";
import type { TursoDb } from "../../turso/turso-db.js";

const AI_SESSIONS_DB_NAME = "ai-sessions.db";

export class AISessionManager {
  private db: TursoDb | null = null;
  private dbPath: string;
  private readonly sessionRetentionMs: number;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    this.sessionRetentionMs = CONFIG.aiSessionRetentionDays * 24 * 60 * 60 * 1000;
  }

  reset(): void {
    this.db = null;
    this.initPromise = null;
    this.dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
  }

  private async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);

    this.initPromise = (async () => {
      try {
        this.db = await tursoConnectionManager.getConnection(this.dbPath);
        await this.initDatabase();
      } catch (error) {
        this.initPromise = null;
        this.db = null;
        throw error;
      }
    })();

    return this.initPromise;
  }

  private async ready(): Promise<TursoDb> {
    if (!this.db || !this.initPromise) {
      await this.initialize();
    } else {
      await this.initPromise;
    }

    if (!this.db) {
      throw new Error("AISessionManager: database not initialized");
    }

    return this.db;
  }

  private async initDatabase(): Promise<void> {
    const db = this.db!;
    await db.batch([
      {
        sql: `
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
        `,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_id ON ai_sessions(session_id)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires_at ON ai_sessions(expires_at)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider ON ai_sessions(provider)" },
      {
        sql: `
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
        `,
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(ai_session_id, sequence)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_ai_messages_role ON ai_messages(ai_session_id, role)",
      },
    ]);
  }

  async getSession(sessionId: string, provider: AIProviderType): Promise<AISession | null> {
    const db = await this.ready();
    const row = await db.get(
      `
      SELECT * FROM ai_sessions
      WHERE session_id = ? AND provider = ? AND expires_at > ?
    `,
      [sessionId, provider, Date.now()]
    );
    return row ? this.rowToSession(row) : null;
  }

  async createSession(params: SessionCreateParams): Promise<AISession> {
    const db = await this.ready();
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    const expiresAt = now + this.sessionRetentionMs;

    await db.run(
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

    return (await this.getSession(params.sessionId, params.provider))!;
  }

  async updateSession(
    sessionId: string,
    provider: AIProviderType,
    updates: SessionUpdateParams
  ): Promise<void> {
    const db = await this.ready();
    const fields: string[] = [];
    const values: InValue[] = [];

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
    values.push(sessionId, provider);

    await db.run(
      `
      UPDATE ai_sessions
      SET ${fields.join(", ")}
      WHERE session_id = ? AND provider = ?
    `,
      values
    );
  }

  async cleanupExpiredSessions(): Promise<number> {
    const db = await this.ready();
    return db.run(`DELETE FROM ai_sessions WHERE expires_at < ?`, [Date.now()]);
  }

  async deleteSession(sessionId: string, provider: AIProviderType): Promise<void> {
    const db = await this.ready();
    await db.run(`DELETE FROM ai_sessions WHERE session_id = ? AND provider = ?`, [
      sessionId,
      provider,
    ]);
  }

  async addMessage(message: Omit<AIMessage, "id" | "createdAt">): Promise<void> {
    const db = await this.ready();
    await db.run(
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

  async getMessages(aiSessionId: string): Promise<AIMessage[]> {
    const db = await this.ready();
    const rows = await db.all(
      "SELECT * FROM ai_messages WHERE ai_session_id = ? ORDER BY sequence ASC",
      [aiSessionId]
    );
    return rows.map((row) => this.rowToMessage(row));
  }

  async getLastSequence(aiSessionId: string): Promise<number> {
    const db = await this.ready();
    const row = await db.get(
      "SELECT MAX(sequence) as max_seq FROM ai_messages WHERE ai_session_id = ?",
      [aiSessionId]
    );
    return row?.max_seq != null ? Number(row.max_seq) : -1;
  }

  async clearMessages(aiSessionId: string): Promise<void> {
    const db = await this.ready();
    await db.run("DELETE FROM ai_messages WHERE ai_session_id = ?", [aiSessionId]);
  }

  private rowToSession(row: Record<string, unknown>): AISession {
    return {
      id: String(row.id),
      provider: row.provider as AIProviderType,
      sessionId: String(row.session_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: Number(row.expires_at),
    };
  }

  private rowToMessage(row: Record<string, unknown>): AIMessage {
    return {
      id: Number(row.id),
      aiSessionId: String(row.ai_session_id),
      sequence: Number(row.sequence),
      role: row.role as AIMessage["role"],
      content: String(row.content),
      toolCalls: row.tool_calls ? JSON.parse(String(row.tool_calls)) : undefined,
      toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
      contentBlocks: row.content_blocks ? JSON.parse(String(row.content_blocks)) : undefined,
      createdAt: Number(row.created_at),
    };
  }
}

export const aiSessionManager = new AISessionManager();
