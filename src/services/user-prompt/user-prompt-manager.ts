import { join } from "node:path";
import { tursoConnectionManager } from "../turso/connection-manager.js";
import { isIdxDeleteMismatchError } from "../turso/error-classifiers.js";
import { CONFIG } from "../../config.js";
import type { SqlValue, TursoDb, TursoTx } from "../turso/turso-db.js";
import { log } from "../logger.js";

import { sanitizeMemoryContent, isFullyPrivate } from "../privacy.js";
import { truncateToMaxBytes } from "../../utils/context-limit.js";

const CAPTURE_EVIDENCE_TTL = 24 * 60 * 60 * 1000;
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
    await this.initialize();
    // Connection manager is authoritative: another plugin instance's dispose
    // may close/replace the pooled handle underneath a cached TursoDb (#443).
    if (this.db) {
      const current = await tursoConnectionManager.getConnection(this.dbPath);
      if (current === this.db) {
        return this.db;
      }
      this.reset();
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("UserPromptManager: database not initialized");
    }

    return this.db;
  }

  private async initDatabase(): Promise<void> {
    const db = this.db!;
    const { applySchemaMigrations, USER_PROMPTS_MIGRATIONS, ensureUserPromptColumns } =
      await import("../turso/schema-migrations.js");
    await applySchemaMigrations(db, USER_PROMPTS_MIGRATIONS, {
      dbPath: this.dbPath,
      label: "user-prompts.db",
    });
    await ensureUserPromptColumns(db);
    await db.run("UPDATE user_prompts SET captured = 0 WHERE captured = 2");
    await this.pruneCaptureEvidence(db);
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
      [
        id,
        sessionId,
        messageId,
        projectPath,
        sanitizeMemoryContent(content),
        now,
        sessionId,
        messageId,
      ]
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

  private async pruneCaptureEvidence(db: TursoDb | TursoTx): Promise<void> {
    await db.run(
      `DELETE FROM pending_capture_evidence WHERE updated_at <= ?
      OR NOT EXISTS (SELECT 1 FROM user_prompts p
        WHERE p.id = pending_capture_evidence.prompt_id AND p.captured IN (0, 2))`,
      [Date.now() - CAPTURE_EVIDENCE_TTL]
    );
  }

  /** Store only completed text/tool evidence, never raw event payloads. */
  async saveCaptureEvidence(
    promptId: string,
    projectPath: string,
    partKey: string,
    content: string
  ): Promise<boolean> {
    if (!partKey || partKey.length > 256 || !projectPath) return false;
    const sanitized = sanitizeMemoryContent(content);
    const bounded = truncateToMaxBytes(sanitized, 16 * 1024);
    const db = await this.ready();
    return db.transaction("write", async (tx) => {
      await this.pruneCaptureEvidence(tx);
      if (isFullyPrivate(sanitized)) {
        // A redacted replacement must not leave the previous version replayable.
        await tx.run(
          `DELETE FROM pending_capture_evidence WHERE prompt_id = ? AND part_key = ?
          AND EXISTS (SELECT 1 FROM user_prompts WHERE id = ? AND captured IN (0, 2)
            AND REPLACE(project_path, '\\', '/') = ?)`,
          [promptId, partKey, promptId, projectPath.replace(/\\/g, "/")]
        );
        return false;
      }
      const changed = await tx.run(
        `INSERT INTO pending_capture_evidence
        (prompt_id, part_key, content, updated_at, ready)
        SELECT id, ?, ?, ?, 0 FROM user_prompts
        WHERE id = ? AND captured IN (0, 2) AND REPLACE(project_path, '\\', '/') = ?
        ON CONFLICT (prompt_id, part_key) DO UPDATE SET
          ready = CASE WHEN pending_capture_evidence.content = excluded.content THEN pending_capture_evidence.ready ELSE 0 END,
          content = excluded.content, updated_at = excluded.updated_at`,
        [partKey, bounded, Date.now(), promptId, projectPath.replace(/\\/g, "/")]
      );
      if (!changed) return false;
      // Retain the most recently updated parts. Ties are deterministic across restarts.
      await tx.run(
        `DELETE FROM pending_capture_evidence WHERE prompt_id = ? AND part_key IN (
        SELECT part_key FROM pending_capture_evidence WHERE prompt_id = ?
        ORDER BY updated_at DESC, part_key DESC LIMIT -1 OFFSET 16)`,
        [promptId, promptId]
      );
      await tx.run(`DELETE FROM pending_capture_evidence WHERE rowid IN (
        SELECT rowid FROM pending_capture_evidence
        ORDER BY updated_at DESC, prompt_id DESC, part_key DESC LIMIT -1 OFFSET 256)`);
      return !!(await tx.get(
        `SELECT 1 FROM pending_capture_evidence WHERE prompt_id = ? AND part_key = ?`,
        [promptId, partKey]
      ));
    });
  }

  async markCaptureEvidenceReady(sessionId: string, projectPath: string): Promise<void> {
    const db = await this.ready();
    await this.pruneCaptureEvidence(db);
    await db.run(
      `UPDATE pending_capture_evidence SET ready = 1 WHERE prompt_id IN (
      SELECT id FROM user_prompts WHERE session_id = ? AND captured IN (0, 2)
      AND REPLACE(project_path, '\\', '/') = ?)`,
      [sessionId, projectPath.replace(/\\/g, "/")]
    );
  }

  async getCaptureEvidence(promptId: string, projectPath: string): Promise<string | null> {
    const db = await this.ready();
    await this.pruneCaptureEvidence(db);
    const rows = await db.all(
      `SELECT e.content FROM pending_capture_evidence e
      JOIN user_prompts p ON p.id = e.prompt_id
      WHERE p.id = ? AND p.captured IN (0, 2) AND REPLACE(p.project_path, '\\', '/') = ?
        AND e.ready = 1 AND e.updated_at > ?
      ORDER BY e.updated_at ASC, e.part_key ASC`,
      [promptId, projectPath.replace(/\\/g, "/"), Date.now() - CAPTURE_EVIDENCE_TTL]
    );
    return rows.length
      ? truncateToMaxBytes(rows.map((r) => String(r.content)).join("\n\n"), 64 * 1024)
      : null;
  }

  async getPendingCaptureSessions(projectPath: string): Promise<string[]> {
    const db = await this.ready();
    await this.pruneCaptureEvidence(db);
    const rows = await db.all(
      `SELECT DISTINCT p.session_id FROM user_prompts p
      JOIN pending_capture_evidence e ON e.prompt_id = p.id
      WHERE p.captured = 0 AND p.capture_attempts < ? AND REPLACE(p.project_path, '\\', '/') = ?
        AND e.ready = 1 AND e.updated_at > ? ORDER BY p.session_id`,
      [
        CONFIG.autoCaptureMaxRetries ?? 3,
        projectPath.replace(/\\/g, "/"),
        Date.now() - CAPTURE_EVIDENCE_TTL,
      ]
    );
    return rows.map((r) => String(r.session_id));
  }

  async getPendingPromptForMessage(
    sessionId: string,
    messageId: string,
    projectPath: string
  ): Promise<UserPrompt | null> {
    const db = await this.ready();
    const row = await db.get(
      `SELECT * FROM user_prompts WHERE session_id = ? AND message_id = ?
      AND captured IN (0, 2) AND REPLACE(project_path, '\\', '/') = ? ORDER BY created_at ASC LIMIT 1`,
      [sessionId, messageId, projectPath.replace(/\\/g, "/")]
    );
    return row ? this.rowToPrompt(row) : null;
  }

  async hasPendingCaptureSession(sessionId: string, projectPath: string): Promise<boolean> {
    const db = await this.ready();
    return !!(await db.get(
      `SELECT 1 FROM user_prompts WHERE session_id = ? AND captured IN (0, 2)
      AND REPLACE(project_path, '\\', '/') = ? LIMIT 1`,
      [sessionId, projectPath.replace(/\\/g, "/")]
    ));
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

  /** Latest saved prompt text for a session (any capture state), for relevance recall. */
  async getLatestPromptTextForSession(sessionId: string): Promise<string | null> {
    const db = await this.ready();
    const row = await db.get(
      `
      SELECT content FROM user_prompts
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      [sessionId]
    );
    if (!row?.content) return null;
    const text = String(row.content).trim();
    return text.length > 0 ? text : null;
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
    await db.transaction("write", async (tx) => {
      await tx.run(`DELETE FROM pending_capture_evidence WHERE prompt_id = ?`, [promptId]);
      await tx.run(`DELETE FROM user_prompts WHERE id = ?`, [promptId]);
    });
  }

  async markAsCaptured(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.transaction("write", async (tx) => {
      await tx.run(`UPDATE user_prompts SET captured = 1 WHERE id = ?`, [promptId]);
      await tx.run(`DELETE FROM pending_capture_evidence WHERE prompt_id = ?`, [promptId]);
    });
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
    await db.transaction("write", async (tx) => {
      await tx.run(`UPDATE user_prompts SET captured = 1 WHERE id IN (${placeholders})`, promptIds);
      await tx.run(
        `DELETE FROM pending_capture_evidence WHERE prompt_id IN (${placeholders})`,
        promptIds
      );
    });
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

    try {
      const deleted = await db.transaction("write", async (tx) => {
        await tx.run(
          `DELETE FROM pending_capture_evidence WHERE prompt_id IN (SELECT id FROM user_prompts WHERE created_at < ?)`,
          [cutoffTime]
        );
        return tx.run(`DELETE FROM user_prompts WHERE created_at < ?`, [cutoffTime]);
      });
      return { deleted, linkedMemoryIds };
    } catch (error) {
      if (!isIdxDeleteMismatchError(error)) throw error;
      // Batch DELETE hit a desynced index entry; fall back to per-row deletes.
      log("deleteOldPrompts: IdxDelete on batch, falling back to per-row deletes", {
        error: String(error),
      });
      const rows = await db.all(`SELECT id FROM user_prompts WHERE created_at < ?`, [cutoffTime]);
      let deleted = 0;
      for (const row of rows) {
        const promptId = String(row.id);
        try {
          await db.transaction("write", async (tx) => {
            await tx.run(`DELETE FROM pending_capture_evidence WHERE prompt_id = ?`, [promptId]);
            await tx.run(`DELETE FROM user_prompts WHERE id = ?`, [promptId]);
          });
          deleted++;
        } catch (rowError) {
          if (isIdxDeleteMismatchError(rowError)) {
            const remaining = await db.get(`SELECT id FROM user_prompts WHERE id = ?`, [promptId]);
            if (!remaining) {
              deleted++;
              continue;
            }
          }
          log("deleteOldPrompts: per-row delete failed", {
            promptId,
            error: String(rowError),
          });
        }
      }
      return { deleted, linkedMemoryIds };
    }
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
          `SELECT * FROM user_prompts
           WHERE captured = 1 AND REPLACE(project_path, '\\', '/') = ?
           ORDER BY created_at DESC`,
          [projectPath.replace(/\\/g, "/")]
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
    const params: SqlValue[] = [`%${query}%`];
    let sql = `SELECT * FROM user_prompts WHERE content LIKE ? AND captured = 1`;
    if (projectPath) {
      sql += ` AND REPLACE(project_path, '\\', '/') = ?`;
      params.push(projectPath.replace(/\\/g, "/"));
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

  async updateProjectPath(oldProjectPath: string, newProjectPath: string): Promise<number> {
    if (!oldProjectPath || !newProjectPath || oldProjectPath === newProjectPath) {
      return 0;
    }
    const db = await this.ready();
    const normalizedOldPath = oldProjectPath.replace(/\\/g, "/");
    return db.run(
      `UPDATE user_prompts
       SET project_path = ?
       WHERE REPLACE(project_path, '\\', '/') = ?`,
      [newProjectPath, normalizedOldPath]
    );
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
