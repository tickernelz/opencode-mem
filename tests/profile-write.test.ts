/**
 * Tests for explicit user preference writes via UserProfileManager.
 * Exercises the write path added to src/index.ts `profile` mode
 * by testing the underlying manager directly (no live plugin context needed).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionManager } from "../src/services/sqlite/connection-manager.js";

// We patch CONFIG.storagePath before importing the manager so the DB lands in tmp.
let tmpDir: string;

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
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-test-"));
  });

  afterEach(() => {
    connectionManager.closeAll();
    rmSync(tmpDir, { recursive: true, force: true });
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
