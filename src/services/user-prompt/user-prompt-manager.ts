import { join } from "node:path";
import { tursoConnectionManager } from "../turso/connection-manager.js";
import { CONFIG } from "../../config.js";
import type { InValue } from "@libsql/client";
import type { TursoDb } from "../turso/turso-db.js";

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
  capture_attempts: number;
  providerId: string | null;
  modelId: string | null;
}

export class UserPromptManager {
  private db: TursoDb | null = null;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.dbPath = join(CONFIG.storagePath, USER_PROMPTS_DB_NAME);
  }

  reset(): void {
    this.db = null;
    this.initPromise = null;
    this.dbPath = join(CONFIG.storagePath, USER_PROMPTS_DB_NAME);
  }

  private async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        this.dbPath = join(CONFIG.storagePath, USER_PROMPTS_DB_NAME);
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
      throw new Error("UserPromptManager: database not initialized");
    }

    return this.db;
  }

  private async initDatabase(): Promise<void> {
    const db = this.db!;
    await db.batch([
      {
        sql: `
          CREATE TABLE IF NOT EXISTS user_prompts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            project_path TEXT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            captured INTEGER DEFAULT 0,
            user_learning_captured BOOLEAN DEFAULT 0,
            linked_memory_id TEXT,
            capture_attempts INTEGER DEFAULT 0,
            provider_id TEXT,
            model_id TEXT
          )
        `,
      },
      { sql: "UPDATE user_prompts SET captured = 0 WHERE captured = 2" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_captured ON user_prompts(captured)" },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC)",
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_path)" },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_linked ON user_prompts(linked_memory_id)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_user_learning ON user_prompts(user_learning_captured)",
      },
    ]);

    for (const column of [
      "capture_attempts INTEGER DEFAULT 0",
      "provider_id TEXT",
      "model_id TEXT",
    ]) {
      try {
        await db.run(`ALTER TABLE user_prompts ADD COLUMN ${column}`);
      } catch (error: any) {
        if (!String(error?.message ?? error).includes("duplicate column")) {
          console.warn(`Failed to add ${column.split(" ")[0]} column:`, error);
        }
      }
    }
  }

  async savePrompt(
    sessionId: string,
    messageId: string,
    projectPath: string,
    content: string
  ): Promise<string> {
    const db = await this.ready();
    const id = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    const changes = await db.run(
      `
      INSERT INTO user_prompts (id, session_id, message_id, project_path, content, created_at, captured)
      SELECT ?, ?, ?, ?, ?, ?, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM user_prompts WHERE session_id = ? AND message_id = ?
      )
    `,
      [id, sessionId, messageId, projectPath, content, now, sessionId, messageId]
    );
    if (changes > 0) return id;

    const existing = await db.get(
      `SELECT id FROM user_prompts
       WHERE session_id = ? AND message_id = ?
       ORDER BY created_at ASC
       LIMIT 1`,
      [sessionId, messageId]
    );
    if (existing?.id) return String(existing.id);

    throw new Error("Failed to save or locate user prompt");
  }

  async setPromptModel(messageId: string, providerId: string, modelId: string): Promise<void> {
    const db = await this.ready();
    await db.run(`UPDATE user_prompts SET provider_id = ?, model_id = ? WHERE message_id = ?`, [
      providerId,
      modelId,
      messageId,
    ]);
  }

  async getLastUncapturedPrompt(sessionId: string): Promise<UserPrompt | null> {
    const db = await this.ready();
    const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
    const row = await db.get(
      `
      SELECT * FROM user_prompts
      WHERE session_id = ? AND captured = 0 AND capture_attempts < ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [sessionId, maxRetries]
    );
    return row ? this.rowToPrompt(row) : null;
  }

  async getUncapturedPromptsForSession(sessionId: string): Promise<UserPrompt[]> {
    const db = await this.ready();
    const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
    const rows = await db.all(
      `
      SELECT * FROM user_prompts
      WHERE session_id = ? AND captured = 0 AND capture_attempts < ?
      ORDER BY created_at ASC
    `,
      [sessionId, maxRetries]
    );
    return rows.map((row) => this.rowToPrompt(row));
  }

  async deletePrompt(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run(`DELETE FROM user_prompts WHERE id = ?`, [promptId]);
  }

  async markAsCaptured(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run(`UPDATE user_prompts SET captured = 1 WHERE id = ?`, [promptId]);
  }

  async claimPrompt(promptId: string): Promise<boolean> {
    const db = await this.ready();
    const changes = await db.run(
      `UPDATE user_prompts SET captured = 2 WHERE id = ? AND captured = 0`,
      [promptId]
    );
    return changes > 0;
  }

  async recordFailedAttempt(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run(`UPDATE user_prompts SET capture_attempts = capture_attempts + 1 WHERE id = ?`, [
      promptId,
    ]);
  }

  async releaseClaim(promptId: string): Promise<boolean> {
    const db = await this.ready();
    const changes = await db.run(
      `UPDATE user_prompts SET captured = 0 WHERE id = ? AND captured = 2`,
      [promptId]
    );
    return changes > 0;
  }

  async countUncapturedPrompts(): Promise<number> {
    const db = await this.ready();
    const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
    const row = await db.get(
      `SELECT COUNT(*) as count FROM user_prompts WHERE captured = 0 AND capture_attempts < ?`,
      [maxRetries]
    );
    return Number(row?.count ?? 0);
  }

  async getUncapturedPrompts(limit: number): Promise<UserPrompt[]> {
    const db = await this.ready();
    const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
    const rows = await db.all(
      `
      SELECT * FROM user_prompts
      WHERE captured = 0 AND capture_attempts < ?
      ORDER BY capture_attempts ASC, created_at ASC
      LIMIT ?
    `,
      [maxRetries, limit]
    );
    return rows.map((row) => this.rowToPrompt(row));
  }

  async markMultipleAsCaptured(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;
    const db = await this.ready();
    const placeholders = promptIds.map(() => "?").join(",");
    await db.run(`UPDATE user_prompts SET captured = 1 WHERE id IN (${placeholders})`, promptIds);
  }

  async countUnanalyzedForUserLearning(): Promise<number> {
    const db = await this.ready();
    const row = await db.get(
      `SELECT COUNT(*) as count FROM user_prompts WHERE user_learning_captured = 0`
    );
    return Number(row?.count ?? 0);
  }

  async getPromptsForUserLearning(limit: number): Promise<UserPrompt[]> {
    const db = await this.ready();
    const rows = await db.all(
      `
      SELECT * FROM user_prompts
      WHERE user_learning_captured = 0
      ORDER BY created_at ASC
      LIMIT ?
    `,
      [limit]
    );
    return rows.map((row) => this.rowToPrompt(row));
  }

  async markAsUserLearningCaptured(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run(`UPDATE user_prompts SET user_learning_captured = 1 WHERE id = ?`, [promptId]);
  }

  async markMultipleAsUserLearningCaptured(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;
    const db = await this.ready();
    const placeholders = promptIds.map(() => "?").join(",");
    await db.run(
      `UPDATE user_prompts SET user_learning_captured = 1 WHERE id IN (${placeholders})`,
      promptIds
    );
  }

  async deleteOldPrompts(
    cutoffTime: number
  ): Promise<{ deleted: number; linkedMemoryIds: string[] }> {
    const db = await this.ready();
    const linkedRows = await db.all(
      `
      SELECT linked_memory_id FROM user_prompts
      WHERE created_at < ? AND linked_memory_id IS NOT NULL
    `,
      [cutoffTime]
    );
    const linkedMemoryIds = linkedRows
      .map((row) => row.linked_memory_id)
      .filter((id): id is string => Boolean(id));

    const deleted = await db.run(`DELETE FROM user_prompts WHERE created_at < ?`, [cutoffTime]);
    return { deleted, linkedMemoryIds };
  }

  async vacuum(): Promise<void> {
    const db = await this.ready();
    await db.run("VACUUM");
  }

  async linkMemoryToPrompt(promptId: string, memoryId: string): Promise<void> {
    const db = await this.ready();
    await db.run(`UPDATE user_prompts SET linked_memory_id = ? WHERE id = ?`, [memoryId, promptId]);
  }

  async getPromptById(promptId: string): Promise<UserPrompt | null> {
    const db = await this.ready();
    const row = await db.get(`SELECT * FROM user_prompts WHERE id = ?`, [promptId]);
    return row ? this.rowToPrompt(row) : null;
  }

  async getCapturedPrompts(projectPath?: string): Promise<UserPrompt[]> {
    const db = await this.ready();
    const rows = projectPath
      ? await db.all(
          `SELECT * FROM user_prompts WHERE captured = 1 AND project_path = ? ORDER BY created_at DESC`,
          [projectPath]
        )
      : await db.all(`SELECT * FROM user_prompts WHERE captured = 1 ORDER BY created_at DESC`);
    return rows.map((row) => this.rowToPrompt(row));
  }

  async searchPrompts(
    query: string,
    projectPath?: string,
    limit: number = 20
  ): Promise<UserPrompt[]> {
    const db = await this.ready();
    const params: InValue[] = [`%${query}%`];
    let sql = `SELECT * FROM user_prompts WHERE content LIKE ? AND captured = 1`;
    if (projectPath) {
      sql += ` AND project_path = ?`;
      params.push(projectPath);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = await db.all(sql, params);
    return rows.map((row) => this.rowToPrompt(row));
  }

  async getPromptsByIds(ids: string[]): Promise<UserPrompt[]> {
    if (ids.length === 0) return [];
    const db = await this.ready();
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.all(`SELECT * FROM user_prompts WHERE id IN (${placeholders})`, ids);
    return rows.map((row) => this.rowToPrompt(row));
  }

  private rowToPrompt(row: Record<string, unknown>): UserPrompt {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      messageId: String(row.message_id),
      projectPath: row.project_path ? String(row.project_path) : null,
      content: String(row.content),
      createdAt: Number(row.created_at),
      captured: Number(row.captured) === 1,
      userLearningCaptured: Number(row.user_learning_captured) === 1,
      linkedMemoryId: row.linked_memory_id ? String(row.linked_memory_id) : null,
      capture_attempts: Number(row.capture_attempts ?? 0),
      providerId: row.provider_id ? String(row.provider_id) : null,
      modelId: row.model_id ? String(row.model_id) : null,
    };
  }
}

export const userPromptManager = new UserPromptManager();
