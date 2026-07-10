import { getDatabase } from "../sqlite/sqlite-bootstrap.js";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connectionManager } from "../sqlite/connection-manager.js";
import { CONFIG } from "../../config.js";
import type { UserProfile, UserProfileChangelog, UserProfileData } from "./types.js";
import { safeArray } from "./profile-utils.js";
import { EmbeddingService } from "../embedding.js";
import { log } from "../logger.js";
import { cosineSimilarityNumbers, l2Normalize } from "../../utils/math.js";
import { loadOpencodeProvider } from "../ai/opencode-provider-loader.js";

const CENTROID_EMA_WEIGHT = 0.85;
const CENTROID_EMA_WEIGHT_COMPLEMENT = 0.15;
const THREE_WAY_CENTROID_W1 = 0.45;
const THREE_WAY_CENTROID_W2 = 0.45;
const THREE_WAY_CENTROID_W3 = 0.1;
const THOMPSON_PRIOR_ALPHA = 0.5;
const THOMPSON_PRIOR_BETA = 1.5;
const THOMPSON_PRIOR_RECOVERY_RATE = 0.8;
const DIRECTION_VALIDATION_TOLERANCE = 0.03;

/**
 * Gamma sampler (Marsaglia-Tsang 2000).
 * Used by sampleBeta for Thompson Sampling weak-hit upgrades.
 */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function randn(): number {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/**
 * Language-agnostic text normalization for embedding comparison.
 * Strips punctuation and collapses whitespace — the embedding model
 * handles semantic similarity naturally without word-level rules.
 */
function normalizeDescription(text: string): string {
  return text
    .trim()
    .replace(/[，,。！？；;：:、\n\r.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const Database = getDatabase();
type DatabaseType = typeof Database.prototype;

const USER_PROFILES_DB_NAME = "user-profiles.db";

export class UserProfileManager {
  private db!: DatabaseType;
  private readonly dbPath: string;
  private coldBuffer: { preferences: any[]; patterns: any[]; workflows: any[] };
  private coldBufferPath: string;
  private dedupCheckedCache: Set<string> = new Set();

  constructor() {
    this.dbPath = join(CONFIG.storagePath || "", USER_PROFILES_DB_NAME);
    this.coldBufferPath = join(CONFIG.storagePath || "", "cold-buffer.json");
    this.coldBuffer = this.loadColdBuffer();
    try {
      this.db = connectionManager.getConnection(this.dbPath);
      this.initDatabase();
    } catch (e) {
      log("user-profile-manager: db init failed, deferring", { error: String(e) });
    }
  }

  private loadColdBuffer(): { preferences: any[]; patterns: any[]; workflows: any[] } {
    try {
      if (existsSync(this.coldBufferPath)) {
        const raw = readFileSync(this.coldBufferPath, "utf-8");
        const data = JSON.parse(raw);
        if (data.preferences?.length || data.patterns?.length || data.workflows?.length) {
          log("profile cold buffer: loaded from disk", {
            prefs: data.preferences?.length || 0,
            pats: data.patterns?.length || 0,
            wfs: data.workflows?.length || 0,
          });
        }
        return {
          preferences: Array.isArray(data.preferences) ? data.preferences : [],
          patterns: Array.isArray(data.patterns) ? data.patterns : [],
          workflows: Array.isArray(data.workflows) ? data.workflows : [],
        };
      }
    } catch {
      // 文件损坏或不存在，返回空缓冲
    }
    return { preferences: [], patterns: [], workflows: [] };
  }

  private saveColdBuffer(): void {
    try {
      writeFileSync(this.coldBufferPath, JSON.stringify(this.coldBuffer), "utf-8");
    } catch {
      // 磁盘满或无权限时静默失败
    }
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

    const cleanedData: UserProfileData = {
      preferences: safeArray(profileData.preferences),
      patterns: safeArray(profileData.patterns),
      workflows: safeArray(profileData.workflows),
    };

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

    this.addChangelog(id, 1, "create", "Initial profile creation", cleanedData);

    return id;
  }

  updateProfile(
    profileId: string,
    profileData: UserProfileData,
    additionalPromptsAnalyzed: number,
    changeSummary: string
  ): boolean {
    const now = Date.now();

    const cleanedData: UserProfileData = {
      preferences: safeArray(profileData.preferences),
      patterns: safeArray(profileData.patterns),
      workflows: safeArray(profileData.workflows),
    };

    const getVersionStmt = this.db.prepare(`SELECT version FROM user_profiles WHERE id = ?`);
    const versionRow = getVersionStmt.get(profileId) as any;
    const currentVersion = versionRow?.version || 0;
    const newVersion = currentVersion + 1;

    const updateStmt = this.db.prepare(`
      UPDATE user_profiles 
      SET profile_data = ?, 
          version = ?, 
          last_analyzed_at = ?, 
          total_prompts_analyzed = total_prompts_analyzed + ?
      WHERE id = ? AND version = ?
    `);

    const result = updateStmt.run(
      JSON.stringify(cleanedData),
      newVersion,
      now,
      additionalPromptsAnalyzed,
      profileId,
      currentVersion
    );

    if (result.changes === 0) {
      return false;
    }

    this.addChangelog(profileId, newVersion, "update", changeSummary, cleanedData);

    this.cleanupOldChangelogs(profileId);

    return true;
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

  getChangelogById(id: string): UserProfileChangelog | undefined {
    const stmt = this.db.prepare(`SELECT * FROM user_profile_changelogs WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.rowToChangelog(row);
  }

  decayInMemory(data: UserProfileData): { data: UserProfileData; hasChanges: boolean } {
    const now = Date.now();

    const prefResult = this.decayItems(data.preferences, now);
    const patResult = this.decayItems(data.patterns, now);
    const wfResult = this.decayItems(data.workflows, now);

    return {
      data: {
        ...data,
        preferences: prefResult.items,
        patterns: patResult.items,
        workflows: wfResult.items,
      },
      hasChanges: prefResult.hasChanges || patResult.hasChanges || wfResult.hasChanges,
    };
  }

  private decayItems<T extends Record<string, any>>(
    items: T[],
    now: number
  ): { items: T[]; hasChanges: boolean; before: number; removed: number } {
    const before = items.length;
    let hasChanges = false;

    const filtered = items.filter((item) => {
      this.lazyMigrateAlpha(item as any);

      if ((item as any).lastSeen === undefined) (item as any).lastSeen = now;
      if ((item as any).evidence === undefined) (item as any).evidence = [];

      const oldConf = (item as any).confidence;
      this.syncConfidence(item as any);
      if ((item as any).confidence !== oldConf) hasChanges = true;

      const age = now - ((item as any).lastSeen || now);
      const ageDays = age / (24 * 60 * 60 * 1000);
      const alpha = (item as any).alpha ?? 1;

      if (alpha <= 2 && ageDays > 30) {
        log("profile decay: removed stale", {
          cat: (item as any).category || (item as any).description?.substring(0, 30),
          alpha,
          ageDays: Math.round(ageDays),
        });
        hasChanges = true;
        return false;
      }

      return true;
    });

    return { items: filtered, hasChanges, before, removed: before - filtered.length };
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

  async mergeProfileData(
    existing: UserProfileData,
    updates: Partial<UserProfileData>,
    embedService?: EmbeddingService,
    profileId?: string
  ): Promise<UserProfileData> {
    const merged: UserProfileData = {
      preferences: this.ensureArray(existing?.preferences),
      patterns: this.ensureArray(existing?.patterns),
      workflows: this.ensureArray(existing?.workflows),
    };

    if (updates.preferences) {
      merged.preferences = await this.mergeItems(
        merged.preferences,
        this.ensureArray(updates.preferences),
        "preference",
        embedService,
        profileId
      );
    }

    if (updates.patterns) {
      merged.patterns = await this.mergeItems(
        merged.patterns,
        this.ensureArray(updates.patterns),
        "pattern",
        embedService,
        profileId
      );
    }

    if (updates.workflows) {
      merged.workflows = await this.mergeItems(
        merged.workflows,
        this.ensureArray(updates.workflows),
        "workflow",
        embedService,
        profileId
      );
    }

    if (profileId) {
      if (merged.preferences.length >= 2) {
        await this.detectConflicts(merged.preferences, "preference", profileId);
        await this.deduplicateItems(merged.preferences, "preference", profileId);
      }
      if (merged.patterns.length >= 2) {
        await this.detectConflicts(merged.patterns, "pattern", profileId);
        await this.deduplicateItems(merged.patterns, "pattern", profileId);
      }
      if (merged.workflows.length >= 2) {
        await this.detectConflicts(merged.workflows, "workflow", profileId);
        await this.deduplicateItems(merged.workflows, "workflow", profileId);
      }
    }

    return merged;
  }

  private async mergeItems<T extends { category?: string; description: string }>(
    existing: T[],
    incoming: T[],
    itemType: "preference" | "pattern" | "workflow",
    embedService?: EmbeddingService,
    profileId?: string
  ): Promise<T[]> {
    const embed = embedService ?? EmbeddingService.getInstance();
    const useEmbedding = embed.isWarmedUp;
    const minDescLen = CONFIG.userProfileEmbeddingMinDescriptionLength;
    const sameCatStrong = CONFIG.userProfileEmbeddingThresholdSameCat;
    const sameCatWeak = CONFIG.userProfileEmbeddingThresholdSameCatWeak;
    const crossCatStrong = CONFIG.userProfileEmbeddingThresholdCrossCat;
    const crossCatWeak = CONFIG.userProfileEmbeddingThresholdCrossCatWeak;
    const driftThreshold = CONFIG.userProfileCentroidDriftThreshold;

    if (!useEmbedding) {
      log("profile embedding skipped: model not warmed up");
    }

    for (const item of existing) {
      this.lazyMigrateAlpha(item as any);
      if ((item as any).lastSeen === undefined)
        (item as any).lastSeen = (item as any).lastUpdated || Date.now();
      if ((item as any).evidence === undefined) (item as any).evidence = [];

      if (useEmbedding && item.description.length >= minDescLen && !(item as any).centroid) {
        try {
          const emb = await embed.embed(normalizeDescription(item.description));
          const arr = Array.from(emb);
          (item as any).centroid = arr;
          (item as any).anchor = arr;
          log("profile centroid migrated", { desc: item.description.substring(0, 30) });
        } catch (e) {
          log("profile centroid migration failed", {
            desc: item.description.substring(0, 30),
            error: String(e),
          });
        }
      }
    }

    let matchCount = 0;
    let newCount = 0;
    if (useEmbedding && (this.coldBuffer as any)[itemType + "s"].length > 0) {
      const buffered = [...(this.coldBuffer as any)[itemType + "s"]];
      (this.coldBuffer as any)[itemType + "s"] = [];
      this.saveColdBuffer();
      log("profile cold start: draining buffer", {
        type: itemType,
        bufferSize: buffered.length,
      });
      incoming = [...buffered, ...incoming];
    }
    log("profile merge start", {
      type: itemType,
      existingCount: existing.length,
      incomingCount: incoming.length,
      embeddingReady: useEmbedding,
    });

    for (const newItem of incoming) {
      const exactIdx = existing.findIndex(
        (e) => e.category === newItem.category && e.description === newItem.description
      );

      if (exactIdx >= 0) {
        const oldFreq = (existing[exactIdx] as any).frequency || 1;
        existing[exactIdx] = this.mergeConfirmedMatch(existing[exactIdx], newItem, itemType, true);
        matchCount++;
        log("profile matched: exact", {
          type: itemType,
          idx: exactIdx,
          cat: newItem.category,
          frequency: `${oldFreq}→${(existing[exactIdx] as any).frequency || "?"}`,
        });
        continue;
      }

      if (useEmbedding && newItem.description.length >= minDescLen) {
        let top1Score = 0;
        let top1Idx = -1;
        let top1SameCat = false;
        let top1Band: "strong" | "weak" | null = null;
        let top2Score = 0;
        let top2Idx = -1;
        let top2SameCat = false;
        let top2Band: "strong" | "weak" | null = null;

        const newEmb = await embed.embed(normalizeDescription(newItem.description));

        for (let i = 0; i < existing.length; i++) {
          const existingItem = existing[i];
          if (!existingItem) continue;

          const centroid = (existingItem as any).centroid as number[] | undefined;
          if (!centroid) continue;

          const score = cosineSimilarityNumbers(Array.from(newEmb), centroid);
          const sameCat = existingItem.category === newItem.category;

          const strongThreshold = sameCat ? sameCatStrong : crossCatStrong;
          const weakThreshold = sameCat ? sameCatWeak : crossCatWeak;

          let band: "strong" | "weak" | null = null;
          if (score >= strongThreshold) {
            band = "strong";
          } else if (score >= weakThreshold) {
            band = "weak";
          } else {
            continue;
          }

          if (score > top1Score) {
            top2Score = top1Score;
            top2Idx = top1Idx;
            top2SameCat = top1SameCat;
            top2Band = top1Band;
            top1Score = score;
            top1Idx = i;
            top1SameCat = sameCat;
            top1Band = band;
          } else if (score > top2Score) {
            top2Score = score;
            top2Idx = i;
            top2SameCat = sameCat;
            top2Band = band;
          }
        }

        if (
          top1Idx >= 0 &&
          top1Band === "strong" &&
          top2Idx >= 0 &&
          top2Band === "strong" &&
          top1SameCat &&
          top2SameCat
        ) {
          const item1 = existing[top1Idx]!;
          const item2 = existing[top2Idx]!;
          const newEmbArr = Array.from(newEmb);
          const threeWayResult = this.combineThree(
            item1,
            item2,
            newItem,
            itemType,
            newEmbArr,
            top1Score
          );
          existing[top1Idx] = threeWayResult as T;
          const removeIdx = top2Idx;
          existing.splice(removeIdx, 1);
          matchCount += 2;
          log("profile matched: three-way merge", {
            type: itemType,
            idx1: top1Idx,
            idx2: removeIdx,
            cat: item1.category,
            score1: Math.round(top1Score * 100) / 100,
            score2: Math.round(top2Score * 100) / 100,
            freq1: (item1 as any).frequency,
            freq2: (item2 as any).frequency,
            combinedFreq: (threeWayResult as any).frequency,
          });
          if (
            this.isMilestone((threeWayResult as any).frequency || 1) &&
            (threeWayResult as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
          ) {
            await this.evolveAndUpdate(threeWayResult as any, itemType, profileId);
          }
          continue;
        }

        if (top1Idx >= 0 && top1Band === "strong") {
          const existingItem = existing[top1Idx]!;
          const oldFreq = (existingItem as any).frequency || 1;
          const centroid = (existingItem as any).centroid as number[];
          const anchor = (existingItem as any).anchor as number[];

          const newEmbArr = Array.from(newEmb);
          const updatedCentroid = l2Normalize(
            centroid.map(
              (v, i) =>
                CENTROID_EMA_WEIGHT * v + CENTROID_EMA_WEIGHT_COMPLEMENT * (newEmbArr[i] ?? 0)
            )
          );

          let driftBelowCount = ((existingItem as any).driftBelowCount as number) || 0;
          if (anchor && anchor.length === updatedCentroid.length) {
            const driftScore = cosineSimilarityNumbers(updatedCentroid, anchor);
            if (driftScore < driftThreshold) {
              driftBelowCount++;
            } else {
              driftBelowCount = 0;
            }
          }

          if (driftBelowCount >= 2) {
            const driftCentroid = Array.from(newEmb);
            const driftAnchor = driftCentroid;
            const frozenItem = { ...existingItem };
            (frozenItem as any).centroid = centroid;
            (frozenItem as any).driftBelowCount = driftBelowCount;
            existing[top1Idx] = frozenItem as T;
            existing.push(this.initItem(newItem, itemType, driftCentroid, driftAnchor) as T);
            newCount++;
            log("profile drift fuse: frozen existing, new item created", {
              type: itemType,
              idx: top1Idx,
              driftBelowCount,
              driftScore: anchor
                ? Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100
                : null,
            });
            continue;
          }

          const combined = this.mergeConfirmedMatch(
            existingItem,
            newItem,
            itemType,
            top1SameCat
          ) as T;
          (combined as any).centroid = updatedCentroid;
          (combined as any).anchor = anchor;
          (combined as any).driftBelowCount = driftBelowCount;
          (combined as any).weakHitCount = 0;
          (combined as any).lastWeakHitAt = null;

          if (
            top1Score > 0.9 &&
            top1SameCat &&
            newItem.description.length < (existingItem as any).description?.length
          ) {
            (combined as any).description = newItem.description;
          }

          existing[top1Idx] = combined;
          matchCount++;

          if (top1SameCat) {
            const mergeIndices: number[] = [];
            for (let j = 0; j < existing.length; j++) {
              if (j === top1Idx) continue;
              const other = existing[j];
              if (!other || other.category !== existingItem.category) continue;
              const otherCentroid = (other as any).centroid as number[] | undefined;
              if (!otherCentroid) continue;
              const crossScore = cosineSimilarityNumbers(Array.from(newEmb), otherCentroid);
              if (crossScore >= sameCatStrong) {
                mergeIndices.push(j);
                this.lazyMigrateAlpha(combined as any);
                this.lazyMigrateAlpha(other as any);
                (combined as any).alpha += (other as any).alpha || 1;
                (combined as any).beta = ((combined as any).beta || 1) + ((other as any).beta || 1);
                const oldFreq = (combined as any).frequency || 1;
                (combined as any).frequency += (other as any).frequency || 1;
                (combined as any).evidence = [
                  ...new Set([
                    ...this.ensureArray((combined as any).evidence),
                    ...this.ensureArray((other as any).evidence),
                  ]),
                ].slice(0, 10);
                const combinedCentroid = (combined as any).centroid as number[];
                const w1 = oldFreq / (oldFreq + ((other as any).frequency || 1));
                const w2 =
                  ((other as any).frequency || 1) / (oldFreq + ((other as any).frequency || 1));
                const mergedCentroid = l2Normalize(
                  combinedCentroid.map((v, i) => w1 * v + w2 * (otherCentroid[i] ?? 0))
                );
                (combined as any).centroid = mergedCentroid;
                this.syncConfidence(combined as any);
                matchCount++;
                log("profile matched: cross-validation merge", {
                  type: itemType,
                  idx: top1Idx,
                  mergedIdx: j,
                  cat: other.category,
                  crossScore: Math.round(crossScore * 100) / 100,
                  mergedAlpha: Math.round((combined as any).alpha),
                  combinedFreq: (combined as any).frequency,
                });
              }
            }
            for (let i = mergeIndices.length - 1; i >= 0; i--) {
              existing.splice(mergeIndices[i]!, 1);
            }
          }

          const driftInfo =
            anchor && anchor.length === updatedCentroid.length
              ? {
                  driftScore:
                    Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100,
                  driftBelowCount,
                }
              : {};

          log("profile matched: embedding strong", {
            type: itemType,
            idx: top1Idx,
            cat: existingItem.category,
            score: Math.round(top1Score * 100) / 100,
            sameCat: top1SameCat,
            frequency: `${oldFreq}→${(combined as any).frequency || "?"}`,
            ...driftInfo,
          });

          const newFreq = (combined as any).frequency || 1;
          if (
            this.isMilestone(newFreq) &&
            (combined as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
          ) {
            await this.evolveAndUpdate(combined as any, itemType, profileId);
          }

          continue;
        }

        if (top1Idx >= 0 && top1Band === "weak") {
          const existingItem = existing[top1Idx]!;

          if (top1SameCat) {
            const existingDriftBelow = ((existingItem as any).driftBelowCount as number) || 0;
            const centroid = (existingItem as any).centroid as number[];
            const anchor = (existingItem as any).anchor as number[];
            const newEmbArr = Array.from(newEmb);
            const updatedCentroid = l2Normalize(
              centroid.map(
                (v, i) =>
                  CENTROID_EMA_WEIGHT * v + CENTROID_EMA_WEIGHT_COMPLEMENT * (newEmbArr[i] ?? 0)
              )
            );

            let driftBelowCount = existingDriftBelow;
            if (anchor && anchor.length === updatedCentroid.length) {
              const driftScore = cosineSimilarityNumbers(updatedCentroid, anchor);
              if (driftScore < driftThreshold) {
                driftBelowCount = existingDriftBelow + 1;
              } else {
                driftBelowCount = 0;
              }
            }

            if (driftBelowCount >= 2) {
              const driftCentroid = Array.from(newEmb);
              const driftAnchor = driftCentroid;
              const frozenItem = { ...existingItem };
              (frozenItem as any).centroid = centroid;
              (frozenItem as any).driftBelowCount = driftBelowCount;
              existing[top1Idx] = frozenItem as T;
              existing.push(this.initItem(newItem, itemType, driftCentroid, driftAnchor) as T);
              newCount++;
              log("profile drift fuse: forced merge path, frozen existing", {
                type: itemType,
                idx: top1Idx,
                driftBelowCount,
                driftScore: anchor
                  ? Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100
                  : null,
              });
              continue;
            }

            const combined = { ...existingItem };
            (combined as any).alpha = ((existingItem as any).alpha || 1) + top1Score * 1.0;
            (combined as any).frequency = ((existingItem as any).frequency || 1) + 1;
            (combined as any).evidence = [
              ...new Set([
                (newItem as any).description || newItem.description,
                ...this.ensureArray((newItem as any).evidence),
                ...this.ensureArray((existingItem as any as any).evidence),
              ]),
            ].slice(0, 10);
            (combined as any).weakAlpha = 1;
            (combined as any).weakBeta = 1;
            (combined as any).weakHitCount = 0;
            (combined as any).lastWeakHitAt = null;
            (combined as any).lastMatchTime = Date.now();
            (combined as any).centroid = updatedCentroid;
            (combined as any).anchor = anchor;
            (combined as any).driftBelowCount = driftBelowCount;
            this.syncConfidence(combined as any);

            existing[top1Idx] = combined;
            matchCount++;

            const driftInfo =
              anchor && anchor.length === updatedCentroid.length
                ? {
                    driftScore:
                      Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100,
                    driftBelowCount,
                  }
                : {};

            log("profile matched: same-cat forced merge", {
              type: itemType,
              idx: top1Idx,
              cat: existingItem.category,
              score: Math.round(top1Score * 100) / 100,
              confidence: `${Math.round(((existingItem as any).confidence || 0) * 100) / 100}→${Math.round((combined as any).confidence * 100) / 100}`,
              frequency: `${(existingItem as any).frequency || 1}→${(combined as any).frequency || "?"}`,
              ...driftInfo,
            });

            const newFreq = (combined as any).frequency || 1;
            if (
              this.isMilestone(newFreq) &&
              (combined as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
            ) {
              await this.evolveAndUpdate(combined as any, itemType, profileId);
            }

            continue;
          }

          const weakAlpha = ((existingItem as any).weakAlpha || 1) + top1Score;
          const weakBeta = ((existingItem as any).weakBeta || 1) + (1 - top1Score);
          const effectiveAlpha = weakAlpha;
          const effectiveBeta = weakBeta;
          let upgraded = false;
          if (effectiveAlpha + effectiveBeta > 7) {
            upgraded = effectiveAlpha / (effectiveAlpha + effectiveBeta) >= 0.45;
          } else {
            upgraded = sampleBeta(effectiveAlpha, effectiveBeta) >= 0.5;
          }
          if (upgraded) {
            const oldFreq = (existingItem as any).frequency || 1;
            const centroid = (existingItem as any).centroid as number[];
            const anchor = (existingItem as any).anchor as number[];
            const newEmbArr = Array.from(newEmb);
            const updatedCentroid = l2Normalize(
              centroid.map(
                (v, i) =>
                  CENTROID_EMA_WEIGHT * v + CENTROID_EMA_WEIGHT_COMPLEMENT * (newEmbArr[i] ?? 0)
              )
            );

            const combined = this.mergeConfirmedMatch(existingItem, newItem, itemType, false) as T;
            (combined as any).centroid = updatedCentroid;
            (combined as any).anchor = anchor;
            (combined as any).alpha += 0.5;
            (combined as any).weakAlpha = 1;
            (combined as any).weakBeta = 1;
            (combined as any).driftBelowCount = (existingItem as any).driftBelowCount || 0;
            this.syncConfidence(combined as any);

            existing[top1Idx] = combined;
            matchCount++;
            log("profile matched: weak upgrade (thompson)", {
              type: itemType,
              idx: top1Idx,
              cat: existingItem.category,
              score: Math.round(top1Score * 100) / 100,
              weakAlpha: Math.round(weakAlpha * 100) / 100,
              weakBeta: Math.round(weakBeta * 100) / 100,
              forced: effectiveAlpha + effectiveBeta > 7,
              frequency: `${oldFreq}→${(combined as any).frequency || "?"}`,
              incomingDesc: (newItem.description || "").substring(0, 40),
            });

            const newFreq = (combined as any).frequency || 1;
            if (
              this.isMilestone(newFreq) &&
              (combined as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
            ) {
              await this.evolveAndUpdate(combined as any, itemType, profileId);
            }

            continue;
          }
          if (effectiveAlpha + effectiveBeta <= 7) {
            (existingItem as any).weakAlpha = effectiveAlpha;
            (existingItem as any).weakBeta = effectiveBeta;
          } else {
            (existingItem as any).weakAlpha = 1;
            (existingItem as any).weakBeta = 1;
          }
          (existingItem as any).lastSeen = Date.now();
          (existingItem as any).lastWeakHitAt = Date.now();
          log("profile weak hit (thompson)", {
            type: itemType,
            idx: top1Idx,
            cat: existingItem.category,
            score: Math.round(top1Score * 100) / 100,
            weakAlpha: Math.round(weakAlpha * 100) / 100,
            weakBeta: Math.round(weakBeta * 100) / 100,
            forcedReset: effectiveAlpha + effectiveBeta > 7,
            incomingDesc: (newItem.description || "").substring(0, 40),
          });
          continue;
        }
      }

      if (!useEmbedding && newItem.description.length >= minDescLen) {
        const isExplicit =
          (newItem as any).category === "explicit" ||
          (Array.isArray((newItem as any).evidence) &&
            (newItem as any).evidence.includes("manual-write"));
        if (!isExplicit) {
          (this.coldBuffer as any)[itemType + "s"].push(newItem);
          if ((this.coldBuffer as any)[itemType + "s"].length > 50) {
            (this.coldBuffer as any)[itemType + "s"].shift();
          }
          this.saveColdBuffer();
          log("profile cold start: buffered", {
            type: itemType,
            cat: newItem.category,
            bufferSize: (this.coldBuffer as any)[itemType + "s"].length,
          });
          continue;
        }
      }

      let initCentroid: number[] | undefined;
      let initAnchor: number[] | undefined;
      if (useEmbedding && newItem.description.length >= minDescLen) {
        try {
          const emb = await embed.embed(normalizeDescription(newItem.description));
          initCentroid = Array.from(emb);
          initAnchor = initCentroid;
        } catch {}
      }

      existing.push(this.initItem(newItem, itemType, initCentroid, initAnchor) as T);
      newCount++;
      log("profile no match: appended new", {
        type: itemType,
        cat: newItem.category,
        desc: (newItem.description || "").substring(0, 40),
      });
    }

    log("profile merge done", {
      type: itemType,
      matched: matchCount,
      appended: newCount,
      existingAfter: existing.length,
    });

    return existing as T[];
  }

  /**
   * Merge a new confirmed observation into an existing profile entry.
   * ONLY call for confirmed matches (exact, strong sameCat/crossCat, Thompson upgrade).
   * Do NOT call for forced merge or cross-validation — those handle fields directly.
   */
  private mergeConfirmedMatch(
    existing: any,
    newItem: any,
    itemType: string,
    sameCat: boolean
  ): any {
    this.lazyMigrateAlpha(existing);
    const evidence = [
      ...new Set([
        newItem.description,
        ...this.ensureArray(newItem.evidence),
        ...this.ensureArray(existing.evidence),
      ]),
    ].slice(0, 10);

    if (sameCat) {
      const result = {
        ...existing,
        alpha: existing.alpha + 1,
        beta: existing.beta ?? 1,
        weakAlpha: 1,
        weakBeta: 1,
        frequency: (existing.frequency || 1) + 1,
        evidence,
        lastSeen: Date.now(),
        lastMatchTime: Date.now(),
        ...(itemType === "workflow" && newItem.steps?.length ? { steps: newItem.steps } : {}),
      };
      this.syncConfidence(result);
      return result;
    }

    const result = {
      ...existing,
      alpha: existing.alpha + 0.5,
      beta: existing.beta ?? 1,
      weakAlpha: 1,
      weakBeta: 1,
      evidence,
      lastSeen: Date.now(),
      lastMatchTime: Date.now(),
      ...(itemType === "workflow" && newItem.steps?.length ? { steps: newItem.steps } : {}),
    };
    this.syncConfidence(result);
    return result;
  }

  private initItem(newItem: any, itemType: string, centroid?: number[], anchor?: number[]): any {
    const hasEvidence = Array.isArray(newItem.evidence) && newItem.evidence.length > 0;
    const item = {
      ...newItem,
      alpha: hasEvidence ? 1 : 0.3,
      beta: hasEvidence ? 1 : 1.5,
      weakAlpha: 1,
      weakBeta: 1,
      confidence: hasEvidence ? (newItem.confidence ?? 0.5) : 0.2,
      frequency: 1,
      lastSeen: Date.now(),
      lastMatchTime: Date.now(),
      firstSeen: Date.now(),
      evidence: newItem.evidence ?? [],
      weakHitCount: 0,
      driftBelowCount: 0,
      pendingValidation: true,
      centroid,
      anchor,
      ...(itemType === "workflow" && newItem.steps?.length ? { steps: newItem.steps } : {}),
    };
    this.syncConfidence(item);
    return item;
  }

  /**
   * Three-way merge: item1 + item2 + newItem → single combined entry.
   * Called when top-1 and top-2 both strongly match the same new observation
   * within the same category, confirming they describe the same behavior.
   */
  private combineThree(
    item1: any,
    item2: any,
    newItem: any,
    itemType: string,
    newEmb: number[],
    top1Score: number
  ): any {
    this.lazyMigrateAlpha(item1);
    this.lazyMigrateAlpha(item2);
    const freq = (item1.frequency || 1) + (item2.frequency || 1) + 1;
    const evidenceSources = [
      ...this.ensureArray(newItem.evidence),
      ...this.ensureArray(item1.evidence),
      ...this.ensureArray(item2.evidence),
    ];
    const evidence = [...new Set(evidenceSources)].slice(0, 10);
    const centroid = l2Normalize(
      item1.centroid.map(
        (v: number, i: number) =>
          THREE_WAY_CENTROID_W1 * v +
          THREE_WAY_CENTROID_W2 * (item2.centroid[i] ?? 0) +
          THREE_WAY_CENTROID_W3 * (newEmb[i] ?? 0)
      )
    );
    const anchor = item1.anchor;
    const newIsShorter = newItem.description.length < (item1.description?.length || Infinity);
    const description = top1Score > 0.9 && newIsShorter ? newItem.description : item1.description;
    const steps =
      itemType === "workflow" && (item1.steps || item2.steps)
        ? item1.steps?.length && item1.steps.length >= (item2.steps?.length || 0)
          ? item1.steps
          : item2.steps
        : newItem.steps;
    const result = {
      ...item1,
      description,
      frequency: freq,
      evidence,
      centroid,
      anchor,
      alpha: (item1.alpha || 1) + (item2.alpha || 1) + 1,
      beta: (item1.beta || 1) + (item2.beta || 1),
      weakAlpha: 1,
      weakBeta: 1,
      weakHitCount: 0,
      driftBelowCount: 0,
      lastSeen: Date.now(),
      lastMatchTime: Date.now(),
      ...(steps ? { steps } : {}),
    };
    this.syncConfidence(result);
    return result;
  }

  private ensureArray(val: any): any[] {
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        log("ensureArray: failed to parse JSON string, returning []", {
          val: String(val).substring(0, 100),
          error: String(e),
        });
        return [];
      }
    }
    return Array.isArray(val) ? val : [];
  }

  private isMilestone(frequency: number): boolean {
    if (frequency <= 20) return [2, 5, 10, 20].includes(frequency);
    return frequency % 20 === 0;
  }

  private minEvidenceForEvolve(_itemType: string): number {
    return 4;
  }

  syncConfidence(item: any): void {
    const alpha = item.alpha ?? 1;
    const beta = item.beta ?? 1;
    const betaMean = alpha / (alpha + beta);
    const decayThreshold = CONFIG.userProfileConfidenceDecayDays * 24 * 60 * 60 * 1000;
    const freq = item.frequency || 1;
    const halfLife = decayThreshold * (1 + Math.log2(1 + freq));
    const age = Date.now() - (item.lastSeen || Date.now());
    const ageMs = Math.max(0, age - decayThreshold);
    const timeFactor = Math.exp((-Math.LN2 * ageMs) / halfLife);
    const matchTime = item.lastMatchTime || item.lastSeen || Date.now();
    const matchAge = (Date.now() - matchTime) / (24 * 60 * 60 * 1000);
    const trendMultiplier = 0.8 + 0.2 * Math.exp(-matchAge / 30);
    item.confidence = betaMean * Math.min(timeFactor, trendMultiplier);
  }

  private lazyMigrateAlpha(item: any): void {
    const needsAlphaMigration =
      item.alpha === undefined || (item.alpha === 0.5 && item.beta === 1.5);
    if (needsAlphaMigration) {
      const conf = item.confidence ?? 1.0;
      if (conf >= 1.0) {
        item.alpha = 1 + (item.frequency || 1) * 0.5;
      } else {
        item.alpha = conf / (1 - conf + 0.01);
      }
      item.beta = 1;
    }
    item.weakAlpha = item.weakAlpha ?? 1;
    item.weakBeta = item.weakBeta ?? 1;
    item.lastMatchTime = item.lastMatchTime ?? item.lastSeen ?? Date.now();
    item.firstSeen = item.firstSeen ?? item.lastSeen ?? Date.now();
    if (item.pendingValidation === undefined) {
      item.pendingValidation = false;
    }
    this.syncConfidence(item);
  }

  private async detectConflicts(items: any[], itemType: string, profileId: string): Promise<void> {
    const candidates: { a: any; b: any; cos: number }[] = [];
    const limit = items.length;
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        if (items[i].category !== items[j].category) continue;
        const c1 = items[i].centroid as number[] | undefined;
        const c2 = items[j].centroid as number[] | undefined;
        if (!c1 || !c2) continue;
        const cos = cosineSimilarityNumbers(c1, c2);
        if (cos >= 0.65 && cos < 0.9) {
          candidates.push({ a: items[i], b: items[j], cos });
        }
      }
    }
    if (candidates.length === 0) return;
    const maxChecks = 3;
    candidates.sort((x, y) => y.cos - x.cos);
    let checked = 0;
    const removeIndices: number[] = [];
    for (const { a, b, cos } of candidates) {
      if (checked >= maxChecks) break;
      if (removeIndices.includes(items.indexOf(a)) || removeIndices.includes(items.indexOf(b)))
        continue;
      const conflict = await this.checkConflict(a.description, b.description);
      if (conflict) {
        checked++;
        const keeper = (a.frequency || 0) >= (b.frequency || 0) ? a : b;
        const removed = keeper === a ? b : a;
        this.lazyMigrateAlpha(keeper);
        this.lazyMigrateAlpha(removed);
        const oldAlpha = keeper.alpha || 1;
        keeper.alpha *= 0.75;
        keeper.beta = (keeper.beta || 1) + 0.25 * oldAlpha;
        keeper.alpha += removed.alpha || 0;
        keeper.frequency = (keeper.frequency || 0) + (removed.frequency || 0);
        keeper.evidence = [
          ...new Set([...this.ensureArray(keeper.evidence), ...this.ensureArray(removed.evidence)]),
        ].slice(0, 10);
        if (itemType === "workflow") {
          keeper.steps =
            keeper.steps?.length >= (removed.steps?.length || 0) ? keeper.steps : removed.steps;
        }
        const removedIdx = items.indexOf(removed);
        if (removedIdx >= 0) removeIndices.push(removedIdx);
        this.syncConfidence(keeper);
        log("profile conflict detected: resolved", {
          type: itemType,
          keeper: (keeper.description || "").substring(0, 40),
          removed: (removed.description || "").substring(0, 40),
          cos: Math.round(cos * 100) / 100,
          alphaDrop: `${Math.round(oldAlpha)}→${Math.round(keeper.alpha)}`,
        });
      }
    }
    for (let i = removeIndices.length - 1; i >= 0; i--) {
      items.splice(removeIndices[i]!, 1);
    }
  }

  private async checkSemanticDuplicate(descA: string, descB: string): Promise<boolean> {
    const prompt = `Do these two descriptions refer to the same user behavior, preference, or pattern? Answer only whether they are semantically equivalent (same meaning, different wording).

A: "${descA}"
B: "${descB}"

Answer JSON only: { "duplicate": true|false, "reason": "one sentence explanation" }`;

    if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
      try {
        const { z } = await import("zod");
        const { generateStructuredOutput } = await loadOpencodeProvider();
        const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

        let v2Client;
        try {
          v2Client = await getOpenCodeClient();
        } catch (e) {
          log("profile dedup check: native provider not connected", { error: String(e) });
        }

        if (v2Client) {
          const result: any = await Promise.race([
            generateStructuredOutput({
              client: v2Client,
              providerID: CONFIG.opencodeProvider,
              modelID: CONFIG.opencodeModel,
              systemPrompt: "You are a semantic duplicate detector. Output valid JSON.",
              userPrompt: prompt,
              schema: z.object({ duplicate: z.boolean(), reason: z.string() }),
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("dedup check timeout")), 30000)
            ),
          ]);
          return result.duplicate || false;
        }
      } catch (e) {
        log("profile dedup check: native provider failed", { error: String(e) });
      }
    }

    if (CONFIG.memoryModel && CONFIG.memoryApiUrl) {
      try {
        const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`,
          },
          body: JSON.stringify({
            model: CONFIG.memoryModel,
            messages: [
              {
                role: "system",
                content: "You are a semantic duplicate detector. Output valid JSON.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) return false;
        const data: any = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return false;
        const parsed = JSON.parse(content);
        return parsed.duplicate || false;
      } catch (e) {
        log("profile dedup check: external API failed", { error: String(e) });
      }
    }

    return false;
  }

  private async deduplicateItems(
    items: any[],
    itemType: string,
    profileId?: string
  ): Promise<void> {
    if (!profileId || items.length < 2) return;

    const checkedPairs = this.dedupCheckedCache;
    const maxLLMCalls = 5;
    let llmCalls = 0;
    let skippedCached = 0;

    const byCategory = new Map<string, typeof items>();
    for (const item of items) {
      const cat = item.category || "_uncategorized";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(item);
    }

    for (const [, group] of byCategory) {
      if (group.length < 2) continue;

      const candidates: { a: any; b: any; cos: number }[] = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const c1 = group[i].centroid as number[] | undefined;
          const c2 = group[j].centroid as number[] | undefined;
          if (!c1 || !c2) continue;
          const cos = cosineSimilarityNumbers(c1, c2);
          if (cos >= 0.5) {
            candidates.push({ a: group[i], b: group[j], cos });
          }
        }
      }

      if (candidates.length === 0) continue;
      candidates.sort((x, y) => y.cos - x.cos);

      const removeIndices: number[] = [];
      let candidateIdx = 0;
      for (const { a, b, cos } of candidates) {
        candidateIdx++;
        if (llmCalls >= maxLLMCalls) {
          log("profile dedup: LLM call limit reached", {
            itemType,
            skipped: candidates.length - candidateIdx + 1,
          });
          break;
        }
        if (removeIndices.includes(items.indexOf(a)) || removeIndices.includes(items.indexOf(b)))
          continue;

        const pairKey = [a.description, b.description].sort().join("||").substring(0, 100);
        if (checkedPairs.has(pairKey)) {
          skippedCached++;
          continue;
        }

        llmCalls++;
        const isDuplicate = await this.checkSemanticDuplicate(a.description, b.description);

        if (isDuplicate) {
          const keeper = (a.frequency || 0) >= (b.frequency || 0) ? a : b;
          const removed = keeper === a ? b : a;
          keeper.frequency = (keeper.frequency || 0) + (removed.frequency || 0);
          this.lazyMigrateAlpha(keeper);
          this.lazyMigrateAlpha(removed);
          keeper.alpha += removed.alpha || 0;
          keeper.beta = (keeper.beta || 1) + (removed.beta || 1);
          keeper.weakAlpha = (keeper.weakAlpha || 1) + ((removed.weakAlpha || 1) - 1);
          keeper.weakBeta = (keeper.weakBeta || 1) + ((removed.weakBeta || 1) - 1);
          keeper.lastSeen = Math.max(keeper.lastSeen || 0, removed.lastSeen || 0);
          keeper.lastMatchTime = Math.max(keeper.lastMatchTime || 0, removed.lastMatchTime || 0);
          this.syncConfidence(keeper);
          keeper.evidence = [
            ...new Set([
              ...this.ensureArray(keeper.evidence),
              ...this.ensureArray(removed.evidence),
            ]),
          ].slice(0, 10);
          keeper.pendingValidation = !!keeper.pendingValidation && !!removed.pendingValidation;
          if (itemType === "workflow") {
            keeper.steps =
              keeper.steps?.length >= (removed.steps?.length || 0) ? keeper.steps : removed.steps;
          }
          const removedIdx = items.indexOf(removed);
          if (removedIdx >= 0) removeIndices.push(removedIdx);
          checkedPairs.delete(pairKey);
          log("profile dedup: merged duplicate", {
            type: itemType,
            keeper: (keeper.description || "").substring(0, 40),
            removed: (removed.description || "").substring(0, 40),
            cos: Math.round(cos * 100) / 100,
            mergedFreq: keeper.frequency,
          });
        } else {
          checkedPairs.add(pairKey);
          log("profile dedup: no duplicate confirmed", {
            type: itemType,
            cos: Math.round(cos * 100) / 100,
          });
        }
      }

      for (let i = removeIndices.length - 1; i >= 0; i--) {
        items.splice(removeIndices[i]!, 1);
      }
    }

    log("profile dedup complete", {
      type: itemType,
      llmCalls,
      skippedCached,
      itemsAfter: items.length,
    });

    if (this.dedupCheckedCache.size > 1000) {
      const entries = [...this.dedupCheckedCache];
      this.dedupCheckedCache = new Set(entries.slice(500));
    }
  }

  private async checkConflict(descA: string, descB: string): Promise<boolean> {
    const prompt = `Are these two user preferences contradictory (opposing, incompatible)?

A: "${descA}"
B: "${descB}"

Answer JSON only: { "conflict": true|false, "reason": "one sentence explanation" }`;

    if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
      try {
        const { z } = await import("zod");
        const { generateStructuredOutput } = await loadOpencodeProvider();
        const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

        let v2Client;
        try {
          v2Client = await getOpenCodeClient();
        } catch (e) {
          log("profile conflict check: native provider not connected", { error: String(e) });
        }

        if (v2Client) {
          const result: any = await Promise.race([
            generateStructuredOutput({
              client: v2Client,
              providerID: CONFIG.opencodeProvider,
              modelID: CONFIG.opencodeModel,
              systemPrompt: "You are a preference contradiction detector. Output valid JSON.",
              userPrompt: prompt,
              schema: z.object({ conflict: z.boolean(), reason: z.string() }),
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("conflict check timeout")), 30000)
            ),
          ]);
          return result.conflict || false;
        }
      } catch (e) {
        log("profile conflict check: native provider failed", { error: String(e) });
      }
    }

    if (CONFIG.memoryModel && CONFIG.memoryApiUrl) {
      try {
        const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`,
          },
          body: JSON.stringify({
            model: CONFIG.memoryModel,
            messages: [
              {
                role: "system",
                content: "You are a preference contradiction detector. Output valid JSON.",
              },
              { role: "user", content: prompt },
            ],
            temperature: 0,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) return false;
        const data: any = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return false;
        const parsed = (() => {
          try {
            return JSON.parse(content);
          } catch {
            const repaired = content
              .replace(
                /([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])"([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g,
                '$1\\"$2'
              )
              .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])"(?=\s*[,}\]])/g, '$1\\"');
            return JSON.parse(repaired);
          }
        })();
        return parsed.conflict || false;
      } catch (e) {
        log("profile conflict check: external API failed", { error: String(e) });
      }
    }

    return false;
  }

  private async evolveDescription(
    item: any,
    itemType: "preference" | "pattern" | "workflow",
    profileId?: string
  ): Promise<string | null> {
    if (!profileId) {
      log("profile description evolution blocked: no profileId");
      return null;
    }

    const evidence = item.evidence;
    if (!Array.isArray(evidence) || evidence.length < this.minEvidenceForEvolve(itemType)) {
      if (Array.isArray(evidence) && evidence.length > 0) {
        log("profile description evolution skipped: insufficient evidence", {
          type: itemType,
          evidenceCount: evidence.length,
          required: this.minEvidenceForEvolve(itemType),
        });
      }
      return null;
    }

    log("profile description evolution attempt", {
      type: itemType,
      desc: (item.description || "").substring(0, 40),
      frequency: item.frequency,
      evidenceCount: evidence.length,
    });

    const evidenceList = evidence.map((e: string, i: number) => `${i + 1}. ${e}`).join("\n");

    const systemPrompt = `You are a user profile description optimizer. Return ONLY a JSON object with a single "description" field: {"description": "..."}
Based on multiple independent observations of the same user behavior, generate a more precise description.
Rules:
- Describe the user's behavioral tendency in general terms
- Natural length — not artificially shortened or inflated
- Same language as the observations
- Do not over-infer beyond what the evidence shows
- Do not include technical implementation details, parameter values, algorithm names, tool names, product names, library names, file paths, error messages, or transient conversation content`;

    const userPrompt = `Current description: ${item.description}

Independent observations:
${evidenceList}

Generate a concise, abstract description of the user's general behavioral tendency.`;

    let newDescription: string | null = null;

    if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
      try {
        newDescription = await this.callOpencodeProvider(systemPrompt, userPrompt);
      } catch (e) {
        log("profile description evolution: native provider failed, trying external API", {
          error: String(e),
        });
      }
    }

    if (!newDescription && CONFIG.memoryModel && CONFIG.memoryApiUrl) {
      try {
        newDescription = await this.callExternalAPI(systemPrompt, userPrompt);
      } catch (e) {
        log("profile description evolution: external API failed", { error: String(e) });
        return null;
      }
    }

    if (!newDescription || newDescription === item.description) {
      if (!newDescription) {
        log("profile description evolution blocked: no provider available");
      } else {
        log("profile description evolution skipped: no change", { type: itemType });
      }
      return null;
    }

    return newDescription;
  }

  async evolveAndUpdate(item: any, itemType: string, profileId?: string): Promise<void> {
    if (!profileId) return;
    try {
      const evolved = await this.evolveDescription(item, itemType as any, profileId);
      if (evolved && evolved !== item.description) {
        const embed = EmbeddingService.getInstance();

        if (embed.isWarmedUp) {
          const evidence = this.ensureArray(item.evidence)
            .filter((e: any) => typeof e === "string" && e.length >= 10)
            .slice(0, 8);

          if (evidence.length >= 3) {
            const oldDesc = item.description;
            const evEmbs = await Promise.all(
              evidence.map((e: string) => embed.embed(normalizeDescription(e)))
            );
            const sumVec = evEmbs.reduce(
              (acc: number[], e: any) => {
                const arr = Array.from(e) as number[];
                return acc.map((v, i) => v + (arr[i] ?? 0));
              },
              new Array((evEmbs[0] as any).length).fill(0) as number[]
            );
            const evCentroid = l2Normalize(sumVec);

            let adopted = false;
            const oldEmb = await embed.embed(normalizeDescription(item.description));
            const newEmb = await embed.embed(normalizeDescription(evolved));
            const cosOld = cosineSimilarityNumbers(Array.from(oldEmb) as number[], evCentroid);
            const cosNew = cosineSimilarityNumbers(Array.from(newEmb) as number[], evCentroid);

            if (cosNew < cosOld - DIRECTION_VALIDATION_TOLERANCE) {
              log("profile description evolution rejected: direction drift", {
                type: itemType,
                cosOld: Math.round(cosOld * 1000) / 1000,
                cosNew: Math.round(cosNew * 1000) / 1000,
              });
            } else {
              item.description = evolved;
              adopted = true;
            }

            if (adopted) {
              const newCentroid = evCentroid;
              const oldCentroid = (item as any).centroid as number[] | undefined;
              (item as any).centroid = newCentroid;
              (item as any).anchor = newCentroid;
              (item as any).driftBelowCount = 0;

              if (oldCentroid) {
                log("profile centroid rebuilt from evidence after evolve", {
                  type: itemType,
                  cosShift:
                    Math.round(cosineSimilarityNumbers(oldCentroid, newCentroid) * 1000) / 1000,
                  evidenceCount: evidence.length,
                  validated: evidence.length >= 3,
                });
              }
            }

            log("profile description evolved", {
              type: itemType,
              oldDescription: oldDesc,
              newDescription: item.description,
              adopted: oldDesc !== item.description,
              frequency: item.frequency,
            });
            return;
          }
        } else {
          log("profile description evolution: embedding not warmed up, skipping validation", {
            type: itemType,
          });
        }

        const oldDesc = item.description;
        item.description = evolved;
        log("profile description evolved", {
          type: itemType,
          oldDescription: oldDesc,
          newDescription: evolved,
          adopted: true,
          frequency: item.frequency,
        });
      }
    } catch (e) {
      log("profile description evolve error", { type: itemType, error: String(e) });
    }
  }

  private async callOpencodeProvider(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string | null> {
    const { generateStructuredOutput } = await loadOpencodeProvider();
    const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

    let v2Client;
    try {
      v2Client = await getOpenCodeClient();
    } catch (e) {
      log("profile description evolution: native provider not connected", {
        provider: CONFIG.opencodeProvider,
        error: String(e),
      });
      return null;
    }

    const { z } = await import("zod");
    const schema = z.object({ description: z.string() });

    const result: any = await Promise.race([
      generateStructuredOutput({
        client: v2Client,
        providerID: CONFIG.opencodeProvider!,
        modelID: CONFIG.opencodeModel!,
        systemPrompt,
        userPrompt,
        schema,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("evolve description timeout")), 120000)
      ),
    ]);

    return result.description || null;
  }

  private async callExternalAPI(systemPrompt: string, userPrompt: string): Promise<string | null> {
    const t0 = Date.now();
    const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`,
      },
      body: JSON.stringify({
        model: CONFIG.memoryModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60000),
    });

    log("profile description evolution: external API http done", {
      httpMs: Date.now() - t0,
      status: response.status,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`External API error: ${response.status} ${text}`);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No content in API response");

    const parsed = JSON.parse(content);
    return parsed.description || null;
  }
}

export const userProfileManager = new UserProfileManager();
