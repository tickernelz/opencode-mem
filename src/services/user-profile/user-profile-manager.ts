import type { Database } from "bun:sqlite";
import type pg from "pg";
import { join } from "node:path";
import { CONFIG } from "../../config.js";
import type { UserProfile, UserProfileChangelog, UserProfileData } from "./types.js";
import { safeArray, safeObject } from "./profile-utils.js";

const USER_PROFILES_DB_NAME = "user-profiles.db";

export class UserProfileManager {
  private db: Database | null = null;
  private pool: pg.Pool | null = null;
  private readonly dbPath: string;

  constructor() {
    this.dbPath = join(CONFIG.storagePath, USER_PROFILES_DB_NAME);
    this.initDatabase();
  }

  private initDatabase(): void {
    if (CONFIG.databaseType === "sqlite") {
      this.initSqlite();
    }
    // PostgreSQL schema is already created by postgres/connection-manager.ts
  }

  private initSqlite(): void {
    const { connectionManager } = require("../database/sqlite/connection-manager.js");
    this.db = connectionManager.getConnection(this.dbPath);

    if (!this.db) {
      throw new Error("Failed to initialize SQLite database");
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_email TEXT NOT NULL,
        profile_data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_analyzed_at INTEGER NOT NULL,
        total_prompts_analyzed INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_profile_changelogs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        change_type TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        profile_data_snapshot TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_profiles_is_active ON user_profiles(is_active)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_profile_id ON user_profile_changelogs(profile_id)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_version ON user_profile_changelogs(version DESC)"
    );
  }

  private async getPool(): Promise<pg.Pool> {
    if (!this.pool) {
      const { connectionManager } = await import("../database/postgres/connection-manager.js");
      this.pool = await connectionManager.getPool();
    }
    return this.pool;
  }

  async getActiveProfile(userId: string): Promise<UserProfile | null> {
    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const stmt = this.db.prepare(`
        SELECT * FROM user_profiles
        WHERE user_id = ? AND is_active = 1
        LIMIT 1
      `);

      const row = stmt.get(userId) as any;
      if (!row) return null;

      return this.rowToProfile(row);
    } else {
      const pool = await this.getPool();
      const result = await pool.query(
        `SELECT * FROM user_profiles
         WHERE user_id = $1 AND is_active = true
         LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) return null;
      return this.rowToProfile(result.rows[0]);
    }
  }

  async createProfile(
    userId: string,
    displayName: string,
    userName: string,
    userEmail: string,
    profileData: UserProfileData,
    promptsAnalyzed: number
  ): Promise<string> {
    const id = `profile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const cleanedData: UserProfileData = {
      preferences: safeArray(profileData.preferences),
      patterns: safeArray(profileData.patterns),
      workflows: safeArray(profileData.workflows),
    };

    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT INTO user_profiles (
          id, user_id, display_name, user_name, user_email,
          profile_data, version, created_at, last_analyzed_at,
          total_prompts_analyzed, is_active
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)
      `);

      stmt.run(
        id,
        userId,
        displayName,
        userName,
        userEmail,
        JSON.stringify(cleanedData),
        now,
        now,
        promptsAnalyzed
      );
    } else {
      const pool = await this.getPool();
      await pool.query(
        `INSERT INTO user_profiles (
          id, user_id, display_name, user_name, user_email,
          profile_data, version, total_prompts_analyzed, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, true)`,
        [id, userId, displayName, userName, userEmail, cleanedData, promptsAnalyzed]
      );
    }

    await this.addChangelog(id, 1, "create", "Initial profile creation", cleanedData);

    return id;
  }

  async updateProfile(
    profileId: string,
    profileData: UserProfileData,
    additionalPromptsAnalyzed: number,
    changeSummary: string
  ): Promise<void> {
    const cleanedData: UserProfileData = {
      preferences: safeArray(profileData.preferences),
      patterns: safeArray(profileData.patterns),
      workflows: safeArray(profileData.workflows),
    };

    let newVersion: number;

    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const now = Date.now();

      const getVersionStmt = this.db.prepare(`SELECT version FROM user_profiles WHERE id = ?`);
      const versionRow = getVersionStmt.get(profileId) as any;
      newVersion = (versionRow?.version || 0) + 1;

      const updateStmt = this.db.prepare(`
        UPDATE user_profiles
        SET profile_data = ?,
            version = ?,
            last_analyzed_at = ?,
            total_prompts_analyzed = total_prompts_analyzed + ?
        WHERE id = ?
      `);

      updateStmt.run(JSON.stringify(cleanedData), newVersion, now, additionalPromptsAnalyzed, profileId);
    } else {
      const pool = await this.getPool();

      const versionResult = await pool.query(`SELECT version FROM user_profiles WHERE id = $1`, [
        profileId,
      ]);
      newVersion = (versionResult.rows[0]?.version || 0) + 1;

      await pool.query(
        `UPDATE user_profiles
         SET profile_data = $1,
             version = $2,
             last_analyzed_at = NOW(),
             total_prompts_analyzed = total_prompts_analyzed + $3
         WHERE id = $4`,
        [cleanedData, newVersion, additionalPromptsAnalyzed, profileId]
      );
    }

    await this.addChangelog(profileId, newVersion, "update", changeSummary, cleanedData);

    await this.cleanupOldChangelogs(profileId);
  }

  private async addChangelog(
    profileId: string,
    version: number,
    changeType: string,
    changeSummary: string,
    profileData: UserProfileData
  ): Promise<void> {
    const id = `changelog_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT INTO user_profile_changelogs (
          id, profile_id, version, change_type, change_summary,
          profile_data_snapshot, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(id, profileId, version, changeType, changeSummary, JSON.stringify(profileData), now);
    } else {
      const pool = await this.getPool();
      await pool.query(
        `INSERT INTO user_profile_changelogs (
          id, profile_id, version, change_type, change_summary,
          profile_data_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, profileId, version, changeType, changeSummary, profileData]
      );
    }
  }

  private async cleanupOldChangelogs(profileId: string): Promise<void> {
    const retentionCount = CONFIG.userProfileChangelogRetentionCount;

    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const stmt = this.db.prepare(`
        DELETE FROM user_profile_changelogs
        WHERE profile_id = ?
        AND id NOT IN (
          SELECT id FROM user_profile_changelogs
          WHERE profile_id = ?
          ORDER BY version DESC
          LIMIT ?
        )
      `);

      stmt.run(profileId, profileId, retentionCount);
    } else {
      const pool = await this.getPool();
      await pool.query(
        `DELETE FROM user_profile_changelogs
         WHERE profile_id = $1
         AND id NOT IN (
           SELECT id FROM user_profile_changelogs
           WHERE profile_id = $1
           ORDER BY version DESC
           LIMIT $2
         )`,
        [profileId, retentionCount]
      );
    }
  }

  async getProfileChangelogs(
    profileId: string,
    limit: number = 10
  ): Promise<UserProfileChangelog[]> {
    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const stmt = this.db.prepare(`
        SELECT * FROM user_profile_changelogs
        WHERE profile_id = ?
        ORDER BY version DESC
        LIMIT ?
      `);

      const rows = stmt.all(profileId, limit) as any[];
      return rows.map((row) => this.rowToChangelog(row));
    } else {
      const pool = await this.getPool();
      const result = await pool.query(
        `SELECT * FROM user_profile_changelogs
         WHERE profile_id = $1
         ORDER BY version DESC
         LIMIT $2`,
        [profileId, limit]
      );

      return result.rows.map((row) => this.rowToChangelog(row));
    }
  }

  async applyConfidenceDecay(profileId: string): Promise<void> {
    const profile = await this.getProfileById(profileId);
    if (!profile) return;

    const profileData: UserProfileData = JSON.parse(profile.profileData);
    const now = Date.now();
    const decayThreshold = CONFIG.userProfileConfidenceDecayDays * 24 * 60 * 60 * 1000;

    let hasChanges = false;

    profileData.preferences = profileData.preferences
      .map((pref) => {
        const age = now - pref.lastUpdated;
        if (age > decayThreshold) {
          hasChanges = true;
          const decayFactor = Math.max(0.5, 1 - (age - decayThreshold) / decayThreshold);
          return { ...pref, confidence: pref.confidence * decayFactor };
        }
        return pref;
      })
      .filter((pref) => pref.confidence >= 0.3);

    if (hasChanges) {
      await this.updateProfile(profileId, profileData, 0, "Applied confidence decay to preferences");
    }
  }

  async deleteProfile(profileId: string): Promise<void> {
    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const stmt = this.db.prepare(`DELETE FROM user_profiles WHERE id = ?`);
      stmt.run(profileId);
    } else {
      const pool = await this.getPool();
      await pool.query(`DELETE FROM user_profiles WHERE id = $1`, [profileId]);
    }
  }

  async getProfileById(profileId: string): Promise<UserProfile | null> {
    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const stmt = this.db.prepare(`SELECT * FROM user_profiles WHERE id = ?`);
      const row = stmt.get(profileId) as any;
      if (!row) return null;
      return this.rowToProfile(row);
    } else {
      const pool = await this.getPool();
      const result = await pool.query(`SELECT * FROM user_profiles WHERE id = $1`, [profileId]);
      if (result.rows.length === 0) return null;
      return this.rowToProfile(result.rows[0]);
    }
  }

  async getAllActiveProfiles(): Promise<UserProfile[]> {
    if (CONFIG.databaseType === "sqlite") {
      if (!this.db) throw new Error("SQLite database not initialized");
      const stmt = this.db.prepare(`SELECT * FROM user_profiles WHERE is_active = 1`);
      const rows = stmt.all() as any[];
      return rows.map((row) => this.rowToProfile(row));
    } else {
      const pool = await this.getPool();
      const result = await pool.query(`SELECT * FROM user_profiles WHERE is_active = true`);
      return result.rows.map((row) => this.rowToProfile(row));
    }
  }

  private rowToProfile(row: any): UserProfile {
    // PostgreSQL returns JSONB as object, SQLite returns TEXT
    const profileData =
      typeof row.profile_data === "string" ? row.profile_data : JSON.stringify(row.profile_data);

    // PostgreSQL returns Date objects, SQLite returns integers
    const createdAt =
      row.created_at instanceof Date ? row.created_at.getTime() : row.created_at;
    const lastAnalyzedAt =
      row.last_analyzed_at instanceof Date ? row.last_analyzed_at.getTime() : row.last_analyzed_at;

    // PostgreSQL returns boolean, SQLite returns 0/1
    const isActive = typeof row.is_active === "boolean" ? row.is_active : row.is_active === 1;

    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      userName: row.user_name,
      userEmail: row.user_email,
      profileData,
      version: row.version,
      createdAt,
      lastAnalyzedAt,
      totalPromptsAnalyzed: row.total_prompts_analyzed,
      isActive,
    };
  }

  private rowToChangelog(row: any): UserProfileChangelog {
    // PostgreSQL returns JSONB as object, SQLite returns TEXT
    const profileDataSnapshot =
      typeof row.profile_data_snapshot === "string"
        ? row.profile_data_snapshot
        : JSON.stringify(row.profile_data_snapshot);

    // PostgreSQL returns Date objects, SQLite returns integers
    const createdAt =
      row.created_at instanceof Date ? row.created_at.getTime() : row.created_at;

    return {
      id: row.id,
      profileId: row.profile_id,
      version: row.version,
      changeType: row.change_type,
      changeSummary: row.change_summary,
      profileDataSnapshot,
      createdAt,
    };
  }

  mergeProfileData(existing: UserProfileData, updates: Partial<UserProfileData>): UserProfileData {
    const merged: UserProfileData = {
      preferences: this.ensureArray(existing?.preferences),
      patterns: this.ensureArray(existing?.patterns),
      workflows: this.ensureArray(existing?.workflows),
    };

    if (updates.preferences) {
      const incomingPrefs = this.ensureArray(updates.preferences);
      for (const newPref of incomingPrefs) {
        const existingIndex = merged.preferences.findIndex(
          (p) => p.category === newPref.category && p.description === newPref.description
        );

        if (existingIndex >= 0) {
          const existingItem = merged.preferences[existingIndex];
          if (existingItem) {
            merged.preferences[existingIndex] = {
              ...newPref,
              confidence: Math.min(1, (existingItem.confidence || 0) + 0.1),
              evidence: [
                ...new Set([
                  ...this.ensureArray(existingItem.evidence),
                  ...this.ensureArray(newPref.evidence),
                ]),
              ].slice(0, 5),
              lastUpdated: Date.now(),
            };
          }
        } else {
          merged.preferences.push({ ...newPref, lastUpdated: Date.now() });
        }
      }

      merged.preferences.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      merged.preferences = merged.preferences.slice(0, CONFIG.userProfileMaxPreferences);
    }

    if (updates.patterns) {
      const incomingPatterns = this.ensureArray(updates.patterns);
      for (const newPattern of incomingPatterns) {
        const existingIndex = merged.patterns.findIndex(
          (p) => p.category === newPattern.category && p.description === newPattern.description
        );

        if (existingIndex >= 0) {
          const existingItem = merged.patterns[existingIndex];
          if (existingItem) {
            merged.patterns[existingIndex] = {
              ...newPattern,
              frequency: (existingItem.frequency || 1) + 1,
              lastSeen: Date.now(),
            };
          }
        } else {
          merged.patterns.push({ ...newPattern, frequency: 1, lastSeen: Date.now() });
        }
      }

      merged.patterns.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
      merged.patterns = merged.patterns.slice(0, CONFIG.userProfileMaxPatterns);
    }

    if (updates.workflows) {
      const incomingWorkflows = this.ensureArray(updates.workflows);
      for (const newWorkflow of incomingWorkflows) {
        const existingIndex = merged.workflows.findIndex(
          (w) => w.description === newWorkflow.description
        );

        if (existingIndex >= 0) {
          const existingItem = merged.workflows[existingIndex];
          if (existingItem) {
            merged.workflows[existingIndex] = {
              ...newWorkflow,
              frequency: (existingItem.frequency || 1) + 1,
            };
          }
        } else {
          merged.workflows.push({ ...newWorkflow, frequency: 1 });
        }
      }

      merged.workflows.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
      merged.workflows = merged.workflows.slice(0, CONFIG.userProfileMaxWorkflows);
    }

    return merged;
  }

  private ensureArray(val: any): any[] {
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return Array.isArray(val) ? val : [];
  }
}

export const userProfileManager = new UserProfileManager();
