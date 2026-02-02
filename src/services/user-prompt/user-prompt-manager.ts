import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CONFIG } from "../../config.js";
import type pg from "pg";

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
  private db?: Database;
  private pool?: pg.Pool;
  private readonly dbPath?: string;

  constructor() {
    if (CONFIG.databaseType === "sqlite") {
      this.dbPath = join(CONFIG.storagePath, USER_PROMPTS_DB_NAME);
      this.initSQLite();
    } else {
      this.initPostgreSQL();
    }
  }

  private initSQLite(): void {
    const { connectionManager } = require("../database/sqlite/connection-manager.js");
    this.db = connectionManager.getConnection(this.dbPath!);

    this.db!.run(`
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

    this.db!.run("UPDATE user_prompts SET captured = 0 WHERE captured = 2");

    this.db!.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_captured ON user_prompts(captured)");
    this.db!.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC)"
    );
    this.db!.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_path)"
    );
    this.db!.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_linked ON user_prompts(linked_memory_id)"
    );
    this.db!.run(
      "CREATE INDEX IF NOT EXISTS idx_user_prompts_user_learning ON user_prompts(user_learning_captured)"
    );
  }

  private async initPostgreSQL(): Promise<void> {
    const { connectionManager } = await import("../database/postgres/connection-manager.js");
    this.pool = await connectionManager.getPool();
  }

  async savePrompt(sessionId: string, messageId: string, projectPath: string, content: string): Promise<string> {
    const id = `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO user_prompts (id, session_id, message_id, project_path, content, created_at, captured)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `);
      stmt.run(id, sessionId, messageId, projectPath, content, now);
    } else if (this.pool) {
      await this.pool.query(
        `INSERT INTO user_prompts (id, session_id, message_id, project_path, content, created_at, captured)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), false)`,
        [id, sessionId, messageId, projectPath, content, now]
      );
    }
    return id;
  }

  async getLastUncapturedPrompt(sessionId: string): Promise<UserPrompt | null> {
    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM user_prompts
        WHERE session_id = ? AND captured = 0
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const row = stmt.get(sessionId) as any;
      if (!row) return null;
      return this.rowToPrompt(row);
    } else if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM user_prompts
         WHERE session_id = $1 AND captured = false
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId]
      );
      if (result.rows.length === 0) return null;
      return this.pgRowToPrompt(result.rows[0]);
    }
    return null;
  }

  async deletePrompt(promptId: string): Promise<void> {
    if (this.db) {
      const stmt = this.db.prepare(`DELETE FROM user_prompts WHERE id = ?`);
      stmt.run(promptId);
    } else if (this.pool) {
      await this.pool.query(`DELETE FROM user_prompts WHERE id = $1`, [promptId]);
    }
  }

  async markAsCaptured(promptId: string): Promise<void> {
    if (this.db) {
      const stmt = this.db.prepare(`UPDATE user_prompts SET captured = 1 WHERE id = ?`);
      stmt.run(promptId);
    } else if (this.pool) {
      await this.pool.query(`UPDATE user_prompts SET captured = true WHERE id = $1`, [promptId]);
    }
  }

  async claimPrompt(promptId: string): Promise<boolean> {
    if (this.db) {
      const stmt = this.db.prepare(
        `UPDATE user_prompts SET captured = 2 WHERE id = ? AND captured = 0`
      );
      const result = stmt.run(promptId);
      return result.changes > 0;
    } else if (this.pool) {
      const result = await this.pool.query(
        `UPDATE user_prompts SET captured = true WHERE id = $1 AND captured = false`,
        [promptId]
      );
      return result.rowCount !== null && result.rowCount > 0;
    }
    return false;
  }

  async countUncapturedPrompts(): Promise<number> {
    if (this.db) {
      const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM user_prompts WHERE captured = 0`);
      const row = stmt.get() as any;
      return row?.count || 0;
    } else if (this.pool) {
      const result = await this.pool.query(`SELECT COUNT(*) as count FROM user_prompts WHERE captured = false`);
      return parseInt(result.rows[0]?.count || "0", 10);
    }
    return 0;
  }

  async getUncapturedPrompts(limit: number): Promise<UserPrompt[]> {
    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM user_prompts
        WHERE captured = 0
        ORDER BY created_at ASC
        LIMIT ?
      `);
      const rows = stmt.all(limit) as any[];
      return rows.map((row) => this.rowToPrompt(row));
    } else if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM user_prompts
         WHERE captured = false
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit]
      );
      return result.rows.map((row) => this.pgRowToPrompt(row));
    }
    return [];
  }

  async markMultipleAsCaptured(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;

    if (this.db) {
      const placeholders = promptIds.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `UPDATE user_prompts SET captured = 1 WHERE id IN (${placeholders})`
      );
      stmt.run(...promptIds);
    } else if (this.pool) {
      const placeholders = promptIds.map((_, i) => `$${i + 1}`).join(",");
      await this.pool.query(
        `UPDATE user_prompts SET captured = true WHERE id IN (${placeholders})`,
        promptIds
      );
    }
  }

  async countUnanalyzedForUserLearning(): Promise<number> {
    if (this.db) {
      const stmt = this.db.prepare(
        `SELECT COUNT(*) as count FROM user_prompts WHERE user_learning_captured = 0`
      );
      const row = stmt.get() as any;
      return row?.count || 0;
    } else if (this.pool) {
      const result = await this.pool.query(
        `SELECT COUNT(*) as count FROM user_prompts WHERE user_learning_captured = false`
      );
      return parseInt(result.rows[0]?.count || "0", 10);
    }
    return 0;
  }

  async getPromptsForUserLearning(limit: number): Promise<UserPrompt[]> {
    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM user_prompts
        WHERE user_learning_captured = 0
        ORDER BY created_at ASC
        LIMIT ?
      `);
      const rows = stmt.all(limit) as any[];
      return rows.map((row) => this.rowToPrompt(row));
    } else if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM user_prompts
         WHERE user_learning_captured = false
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit]
      );
      return result.rows.map((row) => this.pgRowToPrompt(row));
    }
    return [];
  }

  async markAsUserLearningCaptured(promptId: string): Promise<void> {
    if (this.db) {
      const stmt = this.db.prepare(`UPDATE user_prompts SET user_learning_captured = 1 WHERE id = ?`);
      stmt.run(promptId);
    } else if (this.pool) {
      await this.pool.query(`UPDATE user_prompts SET user_learning_captured = true WHERE id = $1`, [promptId]);
    }
  }

  async markMultipleAsUserLearningCaptured(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;

    if (this.db) {
      const placeholders = promptIds.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `UPDATE user_prompts SET user_learning_captured = 1 WHERE id IN (${placeholders})`
      );
      stmt.run(...promptIds);
    } else if (this.pool) {
      const placeholders = promptIds.map((_, i) => `$${i + 1}`).join(",");
      await this.pool.query(
        `UPDATE user_prompts SET user_learning_captured = true WHERE id IN (${placeholders})`,
        promptIds
      );
    }
  }

  async deleteOldPrompts(cutoffTime: number): Promise<{ deleted: number; linkedMemoryIds: string[] }> {
    if (this.db) {
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
    } else if (this.pool) {
      const linkedResult = await this.pool.query(
        `SELECT linked_memory_id FROM user_prompts
         WHERE created_at < to_timestamp($1 / 1000.0) AND linked_memory_id IS NOT NULL`,
        [cutoffTime]
      );
      const linkedMemoryIds = linkedResult.rows.map((row) => row.linked_memory_id).filter((id) => id);

      const deleteResult = await this.pool.query(
        `DELETE FROM user_prompts WHERE created_at < to_timestamp($1 / 1000.0)`,
        [cutoffTime]
      );

      return {
        deleted: deleteResult.rowCount || 0,
        linkedMemoryIds,
      };
    }
    return { deleted: 0, linkedMemoryIds: [] };
  }

  async linkMemoryToPrompt(promptId: string, memoryId: string): Promise<void> {
    if (this.db) {
      const stmt = this.db.prepare(`UPDATE user_prompts SET linked_memory_id = ? WHERE id = ?`);
      stmt.run(memoryId, promptId);
    } else if (this.pool) {
      await this.pool.query(`UPDATE user_prompts SET linked_memory_id = $1 WHERE id = $2`, [memoryId, promptId]);
    }
  }

  async getPromptById(promptId: string): Promise<UserPrompt | null> {
    if (this.db) {
      const stmt = this.db.prepare(`SELECT * FROM user_prompts WHERE id = ?`);
      const row = stmt.get(promptId) as any;
      if (!row) return null;
      return this.rowToPrompt(row);
    } else if (this.pool) {
      const result = await this.pool.query(`SELECT * FROM user_prompts WHERE id = $1`, [promptId]);
      if (result.rows.length === 0) return null;
      return this.pgRowToPrompt(result.rows[0]);
    }
    return null;
  }

  async getCapturedPrompts(projectPath?: string): Promise<UserPrompt[]> {
    if (this.db) {
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
    } else if (this.pool) {
      let query = `SELECT * FROM user_prompts WHERE captured = true`;
      const params: any[] = [];

      if (projectPath) {
        query += ` AND project_path = $1`;
        params.push(projectPath);
      }

      query += ` ORDER BY created_at DESC`;

      const result = await this.pool.query(query, params);
      return result.rows.map((row) => this.pgRowToPrompt(row));
    }
    return [];
  }

  async searchPrompts(query: string, projectPath?: string, limit: number = 20): Promise<UserPrompt[]> {
    if (this.db) {
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
    } else if (this.pool) {
      let sql = `SELECT * FROM user_prompts WHERE content LIKE $1 AND captured = true`;
      const params: any[] = [`%${query}%`];

      if (projectPath) {
        sql += ` AND project_path = $2`;
        params.push(projectPath);
        sql += ` ORDER BY created_at DESC LIMIT $3`;
        params.push(limit);
      } else {
        sql += ` ORDER BY created_at DESC LIMIT $2`;
        params.push(limit);
      }

      const result = await this.pool.query(sql, params);
      return result.rows.map((row) => this.pgRowToPrompt(row));
    }
    return [];
  }

  async getPromptsByIds(ids: string[]): Promise<UserPrompt[]> {
    if (ids.length === 0) return [];

    if (this.db) {
      const placeholders = ids.map(() => "?").join(",");
      const stmt = this.db.prepare(`SELECT * FROM user_prompts WHERE id IN (${placeholders})`);
      const rows = stmt.all(...ids) as any[];
      return rows.map((row) => this.rowToPrompt(row));
    } else if (this.pool) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
      const result = await this.pool.query(
        `SELECT * FROM user_prompts WHERE id IN (${placeholders})`,
        ids
      );
      return result.rows.map((row) => this.pgRowToPrompt(row));
    }
    return [];
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

  private pgRowToPrompt(row: any): UserPrompt {
    return {
      id: row.id,
      sessionId: row.session_id,
      messageId: row.message_id,
      projectPath: row.project_path,
      content: row.content,
      createdAt: new Date(row.created_at).getTime(),
      captured: row.captured === true,
      userLearningCaptured: row.user_learning_captured === true,
      linkedMemoryId: row.linked_memory_id,
    };
  }
}

export const userPromptManager = new UserPromptManager();
