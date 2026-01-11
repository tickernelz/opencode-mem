import { Database } from "bun:sqlite";
import type { AIMessage } from "./session-types.js";

export class MessageStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run(`
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

    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(ai_session_id, sequence)"
    );
    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_messages_role ON ai_messages(ai_session_id, role)");
  }

  addMessage(message: Omit<AIMessage, "id" | "createdAt">): void {
    this.db.run(
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

  getMessages(aiSessionId: string): AIMessage[] {
    const rows = this.db
      .query("SELECT * FROM ai_messages WHERE ai_session_id = ? ORDER BY sequence ASC")
      .all(aiSessionId) as any[];

    return rows.map(this.rowToMessage);
  }

  getLastSequence(aiSessionId: string): number {
    const row = this.db
      .query("SELECT MAX(sequence) as max_seq FROM ai_messages WHERE ai_session_id = ?")
      .get(aiSessionId) as any;

    return row?.max_seq ?? -1;
  }

  clearMessages(aiSessionId: string): void {
    this.db.run("DELETE FROM ai_messages WHERE ai_session_id = ?", [aiSessionId]);
  }

  deleteSession(aiSessionId: string): void {
    this.clearMessages(aiSessionId);
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
}
