/**
 * Tests for explicit user preference writes via UserProfileManager.
 * Exercises the write path added to src/index.ts `profile` mode
 * by testing the underlying manager directly (no live plugin context needed).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionManager } from "../src/services/sqlite/connection-manager.js";
import { removeDirWithRetries } from "./helpers/temp-dir.mjs";

// We patch CONFIG.storagePath before importing the manager so the DB lands in tmp.
let suiteTmpDir: string;
let tmpDir: string;
let testCounter = 0;

const WINDOWS_CLEANUP_LOCK_ERRORS = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

async function makeManager() {
  // Dynamic import after setting storagePath so the constructor picks up the temp dir.
  const { CONFIG } = await import("../src/config.js");
  CONFIG.storagePath = tmpDir;
  // Bun may cache the imported module, so this helper does not try to reload it.
  // Instead, each test creates a new UserProfileManager instance after updating CONFIG.storagePath.
  const { UserProfileManager } =
    await import("../src/services/user-profile/user-profile-manager.js");
  return new UserProfileManager();
}

describe("UserProfileManager – explicit preference writes", () => {
  beforeAll(() => {
    suiteTmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-write-"));
  });

  beforeEach(() => {
    testCounter += 1;
    tmpDir = join(suiteTmpDir, `case-${testCounter}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    connectionManager.closeAll();
  });

  afterAll(async () => {
    connectionManager.closeAll();
    try {
      await removeDirWithRetries(suiteTmpDir, 8);
    } catch (error: any) {
      // Windows can briefly keep SQLite temp dirs locked after closeAll().
      if (!WINDOWS_CLEANUP_LOCK_ERRORS.has(error?.code)) {
        throw error;
      }
    }
  });

  it("creates a profile with an explicit preference when none exists", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";

    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [
          {
            category: "explicit",
            description: "Prefer concise answers",
            confidence: 1.0,
            evidence: ["manual-write"],
            lastUpdated: Date.now(),
          },
        ],
        patterns: [],
        workflows: [],
      },
      0
    );

    const profile = mgr.getActiveProfile(userId);
    expect(profile).not.toBeNull();
    const data = JSON.parse(profile!.profileData);
    expect(data.preferences).toHaveLength(1);
    expect(data.preferences[0].description).toBe("Prefer concise answers");
    expect(data.preferences[0].confidence).toBe(1.0);
    expect(data.preferences[0].evidence).toContain("manual-write");
  });

  it("adds lastUpdated to generated preferences when creating a profile", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";
    const before = Date.now();

    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [
          {
            category: "style",
            description: "Prefers concise answers",
            confidence: 0.7,
            evidence: ["observed"],
          } as any,
        ],
        patterns: [],
        workflows: [],
      },
      10
    );

    const after = Date.now();
    const profile = mgr.getActiveProfile(userId)!;
    const data = JSON.parse(profile.profileData);
    const lastUpdated = data.preferences[0].lastUpdated;

    expect(typeof lastUpdated).toBe("number");
    expect(lastUpdated).toBeGreaterThanOrEqual(before);
    expect(lastUpdated).toBeLessThanOrEqual(after);
  });

  it("applies confidence decay to stale preferences", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";
    const staleTimestamp = Date.now() - 61 * 24 * 60 * 60 * 1000;

    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [
          {
            category: "style",
            description: "Prefers concise answers",
            confidence: 0.8,
            evidence: ["observed"],
            lastUpdated: staleTimestamp,
          },
        ],
        patterns: [],
        workflows: [],
      },
      10
    );

    const profile = mgr.getActiveProfile(userId)!;
    const changed = mgr.applyConfidenceDecay(profile.id);

    expect(changed).toBe(true);

    const updated = mgr.getActiveProfile(userId)!;
    const data = JSON.parse(updated.profileData);

    expect(updated.version).toBe(2);
    expect(data.preferences[0].confidence).toBeCloseTo(0.4, 2);
    expect(data.preferences[0].lastUpdated).toBeGreaterThan(staleTimestamp);

    const changedAgain = mgr.applyConfidenceDecay(updated.id);
    const unchanged = mgr.getActiveProfile(userId)!;

    expect(changedAgain).toBe(false);
    expect(unchanged.version).toBe(2);
  });

  it("removes preferences that decay below the confidence floor", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";
    const staleTimestamp = Date.now() - 61 * 24 * 60 * 60 * 1000;

    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [
          {
            category: "style",
            description: "Weak stale preference",
            confidence: 0.4,
            evidence: ["observed"],
            lastUpdated: staleTimestamp,
          },
        ],
        patterns: [],
        workflows: [],
      },
      10
    );

    const profile = mgr.getActiveProfile(userId)!;
    const changed = mgr.applyConfidenceDecay(profile.id);

    expect(changed).toBe(true);

    const updated = mgr.getActiveProfile(userId)!;
    const data = JSON.parse(updated.profileData);

    expect(data.preferences).toHaveLength(0);
  });

  it("merges a new explicit preference into an existing profile without clobbering other prefs", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";

    // Seed with one AI-learned preference
    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [
          {
            category: "style",
            description: "Uses TypeScript",
            confidence: 0.8,
            evidence: ["observed"],
            lastUpdated: Date.now(),
          },
        ],
        patterns: [],
        workflows: [],
      },
      3
    );

    const existingProfile = mgr.getActiveProfile(userId)!;
    const existingData = JSON.parse(existingProfile.profileData);

    const newPref = {
      category: "explicit",
      description: "Always use numbered lists",
      confidence: 1.0,
      evidence: ["manual-write"],
      lastUpdated: Date.now(),
    };

    const merged = mgr.mergeProfileData(existingData, { preferences: [newPref] });
    mgr.updateProfile(
      existingProfile.id,
      merged,
      0,
      "Explicit preference added: Always use numbered lists"
    );

    const updated = mgr.getActiveProfile(userId)!;
    const updatedData = JSON.parse(updated.profileData);

    expect(updatedData.preferences).toHaveLength(2);
    const descriptions = updatedData.preferences.map((p: any) => p.description);
    expect(descriptions).toContain("Uses TypeScript");
    expect(descriptions).toContain("Always use numbered lists");
    expect(updated.version).toBe(2);
  });

  it("deduplicates when the same explicit preference is written twice, boosting confidence", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";
    const description = "Prefer short answers";

    const pref = {
      category: "explicit",
      description,
      confidence: 1.0,
      evidence: ["manual-write"],
      lastUpdated: Date.now(),
    };

    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [pref],
        patterns: [],
        workflows: [],
      },
      0
    );

    // Write the same preference again (simulates calling profile+content twice)
    const p1 = mgr.getActiveProfile(userId)!;
    const d1 = JSON.parse(p1.profileData);
    const merged = mgr.mergeProfileData(d1, {
      preferences: [{ ...pref, lastUpdated: Date.now() }],
    });
    mgr.updateProfile(p1.id, merged, 0, "Explicit preference added: Prefer short answers");

    const p2 = mgr.getActiveProfile(userId)!;
    const d2 = JSON.parse(p2.profileData);
    // Still only one entry (deduplicated by category+description)
    expect(d2.preferences.filter((p: any) => p.description === description)).toHaveLength(1);
    // Confidence capped at 1.0 (bumped by 0.1 but clamped)
    const conf = d2.preferences.find((p: any) => p.description === description)!.confidence;
    expect(conf).toBeLessThanOrEqual(1.0);
    expect(conf).toBeGreaterThan(0.9);
  });

  it("returns null profile for unknown user (no auto-create on read)", async () => {
    const mgr = await makeManager();
    const profile = mgr.getActiveProfile("nobody@example.com");
    expect(profile).toBeNull();
  });

  it("changelog entry is recorded on explicit preference write", async () => {
    const mgr = await makeManager();
    const userId = "test@example.com";
    const summary = "Explicit preference added: Use snake_case";

    mgr.createProfile(
      userId,
      "Test User",
      "testuser",
      userId,
      {
        preferences: [],
        patterns: [],
        workflows: [],
      },
      0
    );

    const p = mgr.getActiveProfile(userId)!;
    const d = JSON.parse(p.profileData);
    const merged = mgr.mergeProfileData(d, {
      preferences: [
        {
          category: "explicit",
          description: "Use snake_case",
          confidence: 1.0,
          evidence: ["manual-write"],
          lastUpdated: Date.now(),
        },
      ],
    });
    mgr.updateProfile(p.id, merged, 0, summary);

    const changelogs = mgr.getProfileChangelogs(p.id);
    const last = changelogs[0];
    expect(last.changeSummary).toBe(summary);
    expect(last.changeType).toBe("update");
  });
});
