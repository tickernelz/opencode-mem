import { Database } from "bun:sqlite";
import { join } from "node:path";
import { connectionManager } from "../sqlite/connection-manager.js";
import { CONFIG } from "../../config.js";

const USER_PROMPTS_DB_NAME = "user-prompts.db";

export interface UserPrompt {
  id: string;
  sessionId: string;
  messageId: string;
  projectPath: string | null;
  content: string;
  createdAt: number;
  captured: boolean;
  userLearningCaptured: boolean;
  linkedMemoryId: string | null;
}

export class UserPromptManager {
  private db: Database;
  private readonly dbPath: string;

  constructor() {
    this.dbPath = join(CONFIG.storagePath, USER_PROMPTS_DB_NAME);
    this.db = connectionManager.getConnection(this.dbPath);
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        project_path TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        captured BOOLEAN DEFAULT 0,
        user_learning_captured BOOLEAN DEFAULT 0,
        linked_memory_id TEXT
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_captured ON user_prompts(captured)");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_path)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_linked ON user_prompts(linked_memory_id)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_user_learning ON user_prompts(user_learning_captured)"
    );
  }

  savePrompt(sessionId: string, messageId: string, projectPath: string, content: string): string {
    const id = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (id, session_id, message_id, project_path, content, created_at, captured)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(id, sessionId, messageId, projectPath, content, now);
    return id;
  }

  getLastUncapturedPrompt(sessionId: string): UserPrompt | null {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts 
      WHERE session_id = ? AND captured = 0
      ORDER BY created_at DESC 
      LIMIT 1
    `);

    const row = stmt.get(sessionId) as any;
    if (!row) return null;

    return this.rowToPrompt(row);
  }

  deletePrompt(promptId: string): void {
    const stmt = this.db.prepare(`DELETE FROM user_prompts WHERE id = ?`);
    stmt.run(promptId);
  }

  markAsCaptured(promptId: string): void {
    const stmt = this.db.prepare(`UPDATE user_prompts SET captured = 1 WHERE id = ?`);
    stmt.run(promptId);
  }

  countUncapturedPrompts(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM user_prompts WHERE captured = 0`);
    const row = stmt.get() as any;
    return row?.count || 0;
  }

  getUncapturedPrompts(limit: number): UserPrompt[] {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts 
      WHERE captured = 0 
      ORDER BY created_at ASC 
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map((row) => this.rowToPrompt(row));
  }

  markMultipleAsCaptured(promptIds: string[]): void {
    if (promptIds.length === 0) return;

    const placeholders = promptIds.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `UPDATE user_prompts SET captured = 1 WHERE id IN (${placeholders})`
    );
    stmt.run(...promptIds);
  }

  countUnanalyzedForUserLearning(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM user_prompts WHERE user_learning_captured = 0`
    );
    const row = stmt.get() as any;
    return row?.count || 0;
  }

  getPromptsForUserLearning(limit: number): UserPrompt[] {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts 
      WHERE user_learning_captured = 0 
      ORDER BY created_at ASC 
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map((row) => this.rowToPrompt(row));
  }

  markAsUserLearningCaptured(promptId: string): void {
    const stmt = this.db.prepare(`UPDATE user_prompts SET user_learning_captured = 1 WHERE id = ?`);
    stmt.run(promptId);
  }

  markMultipleAsUserLearningCaptured(promptIds: string[]): void {
    if (promptIds.length === 0) return;

    const placeholders = promptIds.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `UPDATE user_prompts SET user_learning_captured = 1 WHERE id IN (${placeholders})`
    );
    stmt.run(...promptIds);
  }

  deleteOldPrompts(cutoffTime: number): { deleted: number; linkedMemoryIds: string[] } {
    const getLinkedStmt = this.db.prepare(`
      SELECT linked_memory_id FROM user_prompts 
      WHERE created_at < ? AND linked_memory_id IS NOT NULL
    `);
    const linkedRows = getLinkedStmt.all(cutoffTime) as any[];
    const linkedMemoryIds = linkedRows.map((row) => row.linked_memory_id).filter((id) => id);

    const deleteStmt = this.db.prepare(`DELETE FROM user_prompts WHERE created_at < ?`);
    const result = deleteStmt.run(cutoffTime);

    return {
      deleted: result.changes,
      linkedMemoryIds,
    };
  }

  linkMemoryToPrompt(promptId: string, memoryId: string): void {
    const stmt = this.db.prepare(`UPDATE user_prompts SET linked_memory_id = ? WHERE id = ?`);
    stmt.run(memoryId, promptId);
  }

  getPromptById(promptId: string): UserPrompt | null {
    const stmt = this.db.prepare(`SELECT * FROM user_prompts WHERE id = ?`);
    const row = stmt.get(promptId) as any;
    if (!row) return null;
    return this.rowToPrompt(row);
  }

  getCapturedPrompts(projectPath?: string): UserPrompt[] {
    let query = `SELECT * FROM user_prompts WHERE captured = 1`;
    const params: any[] = [];

    if (projectPath) {
      query += ` AND project_path = ?`;
      params.push(projectPath);
    }

    query += ` ORDER BY created_at DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];
    return rows.map((row) => this.rowToPrompt(row));
  }

  searchPrompts(query: string, projectPath?: string, limit: number = 20): UserPrompt[] {
    let sql = `SELECT * FROM user_prompts WHERE content LIKE ? AND captured = 1`;
    const params: any[] = [`%${query}%`];

    if (projectPath) {
      sql += ` AND project_path = ?`;
      params.push(projectPath);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map((row) => this.rowToPrompt(row));
  }

  getPromptsByIds(ids: string[]): UserPrompt[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const stmt = this.db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders})`);
    const rows = stmt.all(...ids) as any[];
    return rows.map((row) => this.rowToPrompt(row));
  }

  private rowToPrompt(row: any): UserPrompt {
    return {
      id: row.id,
      sessionId: row.session_id,
      messageId: row.message_id,
      projectPath: row.project_path,
      content: row.content,
      createdAt: row.created_at,
      captured: row.captured === 1,
      userLearningCaptured: row.user_learning_captured === 1,
      linkedMemoryId: row.linked_memory_id,
    };
  }
}

export const userPromptManager = new UserPromptManager();
