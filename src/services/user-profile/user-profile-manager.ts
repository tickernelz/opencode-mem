import { Database } from "bun:sqlite";
import { join } from "node:path";
import { connectionManager } from "../sqlite/connection-manager.js";
import { CONFIG } from "../../config.js";
import type { UserProfile, UserProfileChangelog, UserProfileData } from "./types.js";

const USER_PROFILES_DB_NAME = "user-profiles.db";

export class UserProfileManager {
  private db: Database;
  private readonly dbPath: string;

  constructor() {
    this.dbPath = join(CONFIG.storagePath, USER_PROFILES_DB_NAME);
    this.db = connectionManager.getConnection(this.dbPath);
    this.initDatabase();
  }

  private initDatabase(): void {
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

  getActiveProfile(userId: string): UserProfile | null {
    const stmt = this.db.prepare(`
      SELECT * FROM user_profiles 
      WHERE user_id = ? AND is_active = 1
      LIMIT 1
    `);

    const row = stmt.get(userId) as any;
    if (!row) return null;

    return this.rowToProfile(row);
  }

  createProfile(
    userId: string,
    displayName: string,
    userName: string,
    userEmail: string,
    profileData: UserProfileData,
    promptsAnalyzed: number
  ): string {
    const id = `profile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
      JSON.stringify(profileData),
      now,
      now,
      promptsAnalyzed
    );

    this.addChangelog(id, 1, "create", "Initial profile creation", profileData);

    return id;
  }

  updateProfile(
    profileId: string,
    profileData: UserProfileData,
    additionalPromptsAnalyzed: number,
    changeSummary: string
  ): void {
    const now = Date.now();

    const getVersionStmt = this.db.prepare(`SELECT version FROM user_profiles WHERE id = ?`);
    const versionRow = getVersionStmt.get(profileId) as any;
    const newVersion = (versionRow?.version || 0) + 1;

    const updateStmt = this.db.prepare(`
      UPDATE user_profiles 
      SET profile_data = ?, 
          version = ?, 
          last_analyzed_at = ?, 
          total_prompts_analyzed = total_prompts_analyzed + ?
      WHERE id = ?
    `);

    updateStmt.run(
      JSON.stringify(profileData),
      newVersion,
      now,
      additionalPromptsAnalyzed,
      profileId
    );

    this.addChangelog(profileId, newVersion, "update", changeSummary, profileData);

    this.cleanupOldChangelogs(profileId);
  }

  private addChangelog(
    profileId: string,
    version: number,
    changeType: string,
    changeSummary: string,
    profileData: UserProfileData
  ): void {
    const id = `changelog_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO user_profile_changelogs (
        id, profile_id, version, change_type, change_summary, 
        profile_data_snapshot, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, profileId, version, changeType, changeSummary, JSON.stringify(profileData), now);
  }

  private cleanupOldChangelogs(profileId: string): void {
    const retentionCount = CONFIG.userProfileChangelogRetentionCount;

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
  }

  getProfileChangelogs(profileId: string, limit: number = 10): UserProfileChangelog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM user_profile_changelogs 
      WHERE profile_id = ? 
      ORDER BY version DESC 
      LIMIT ?
    `);

    const rows = stmt.all(profileId, limit) as any[];
    return rows.map((row) => this.rowToChangelog(row));
  }

  applyConfidenceDecay(profileId: string): void {
    const profile = this.getProfileById(profileId);
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
      this.updateProfile(profileId, profileData, 0, "Applied confidence decay to preferences");
    }
  }

  deleteProfile(profileId: string): void {
    const stmt = this.db.prepare(`DELETE FROM user_profiles WHERE id = ?`);
    stmt.run(profileId);
  }

  getProfileById(profileId: string): UserProfile | null {
    const stmt = this.db.prepare(`SELECT * FROM user_profiles WHERE id = ?`);
    const row = stmt.get(profileId) as any;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  getAllActiveProfiles(): UserProfile[] {
    const stmt = this.db.prepare(`SELECT * FROM user_profiles WHERE is_active = 1`);
    const rows = stmt.all() as any[];
    return rows.map((row) => this.rowToProfile(row));
  }

  private rowToProfile(row: any): UserProfile {
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      userName: row.user_name,
      userEmail: row.user_email,
      profileData: row.profile_data,
      version: row.version,
      createdAt: row.created_at,
      lastAnalyzedAt: row.last_analyzed_at,
      totalPromptsAnalyzed: row.total_prompts_analyzed,
      isActive: row.is_active === 1,
    };
  }

  private rowToChangelog(row: any): UserProfileChangelog {
    return {
      id: row.id,
      profileId: row.profile_id,
      version: row.version,
      changeType: row.change_type,
      changeSummary: row.change_summary,
      profileDataSnapshot: row.profile_data_snapshot,
      createdAt: row.created_at,
    };
  }

  mergeProfileData(existing: UserProfileData, updates: Partial<UserProfileData>): UserProfileData {
    const merged: UserProfileData = {
      preferences: [...existing.preferences],
      patterns: [...existing.patterns],
      workflows: [...existing.workflows],
      skillLevel: { ...existing.skillLevel },
    };

    if (updates.preferences) {
      for (const newPref of updates.preferences) {
        const existingIndex = merged.preferences.findIndex(
          (p) => p.category === newPref.category && p.description === newPref.description
        );

        if (existingIndex >= 0) {
          const existing = merged.preferences[existingIndex];
          if (existing) {
            merged.preferences[existingIndex] = {
              ...newPref,
              confidence: Math.min(1, existing.confidence + 0.1),
              evidence: [...new Set([...existing.evidence, ...newPref.evidence])].slice(0, 5),
              lastUpdated: Date.now(),
            };
          }
        } else {
          merged.preferences.push({ ...newPref, lastUpdated: Date.now() });
        }
      }

      merged.preferences.sort((a, b) => b.confidence - a.confidence);
      merged.preferences = merged.preferences.slice(0, CONFIG.userProfileMaxPreferences);
    }

    if (updates.patterns) {
      for (const newPattern of updates.patterns) {
        const existingIndex = merged.patterns.findIndex(
          (p) => p.category === newPattern.category && p.description === newPattern.description
        );

        if (existingIndex >= 0) {
          const existing = merged.patterns[existingIndex];
          if (existing) {
            merged.patterns[existingIndex] = {
              ...newPattern,
              frequency: existing.frequency + 1,
              lastSeen: Date.now(),
            };
          }
        } else {
          merged.patterns.push({ ...newPattern, frequency: 1, lastSeen: Date.now() });
        }
      }

      merged.patterns.sort((a, b) => b.frequency - a.frequency);
      merged.patterns = merged.patterns.slice(0, CONFIG.userProfileMaxPatterns);
    }

    if (updates.workflows) {
      for (const newWorkflow of updates.workflows) {
        const existingIndex = merged.workflows.findIndex(
          (w) => w.description === newWorkflow.description
        );

        if (existingIndex >= 0) {
          const existing = merged.workflows[existingIndex];
          if (existing) {
            merged.workflows[existingIndex] = {
              ...newWorkflow,
              frequency: existing.frequency + 1,
            };
          }
        } else {
          merged.workflows.push({ ...newWorkflow, frequency: 1 });
        }
      }

      merged.workflows.sort((a, b) => b.frequency - a.frequency);
      merged.workflows = merged.workflows.slice(0, CONFIG.userProfileMaxWorkflows);
    }

    if (updates.skillLevel) {
      merged.skillLevel = {
        overall: updates.skillLevel.overall || merged.skillLevel.overall,
        domains: { ...merged.skillLevel.domains, ...updates.skillLevel.domains },
      };
    }

    return merged;
  }
}

export const userProfileManager = new UserProfileManager();
