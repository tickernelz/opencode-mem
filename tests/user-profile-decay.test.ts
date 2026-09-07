import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";

let tmpDir: string;
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeManager() {
  const { CONFIG } = await import("../src/config.js");
  CONFIG.storagePath = tmpDir;
  const { UserProfileManager } =
    await import("../src/services/user-profile/user-profile-manager.js");
  return { mgr: new UserProfileManager(), CONFIG };
}

describe("user profile decay (#237)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-decay-"));
  });

  afterEach(async () => {
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("removes stale items below minEvidence after staleDays", async () => {
    const { mgr, CONFIG } = await makeManager();
    CONFIG.userProfileStaleDays = 2;
    CONFIG.userProfileMinEvidenceForRetention = 3;

    const now = Date.now();
    const { data, hasChanges } = mgr.decayInMemory({
      preferences: [
        {
          category: "style",
          description: "stale low evidence",
          confidence: 0.4,
          evidence: ["once"],
          lastSeen: now - 3 * DAY_MS,
          alpha: 5,
          beta: 1,
        },
      ],
      patterns: [],
      workflows: [],
    });

    expect(hasChanges).toBe(true);
    expect(data.preferences).toHaveLength(0);
  });

  it("keeps items with enough evidence even when stale", async () => {
    const { mgr, CONFIG } = await makeManager();
    CONFIG.userProfileStaleDays = 2;
    CONFIG.userProfileMinEvidenceForRetention = 3;

    const now = Date.now();
    const { data } = mgr.decayInMemory({
      preferences: [
        {
          category: "style",
          description: "well evidenced",
          confidence: 0.6,
          evidence: ["a", "b", "c"],
          lastSeen: now - 10 * DAY_MS,
          alpha: 5,
          beta: 1,
        },
      ],
      patterns: [],
      workflows: [],
    });

    expect(data.preferences).toHaveLength(1);
    expect(data.preferences[0]?.description).toBe("well evidenced");
  });

  it("keeps items within staleDays regardless of evidence", async () => {
    const { mgr, CONFIG } = await makeManager();
    CONFIG.userProfileStaleDays = 2;
    CONFIG.userProfileMinEvidenceForRetention = 3;

    const now = Date.now();
    const { data } = mgr.decayInMemory({
      preferences: [
        {
          category: "style",
          description: "fresh",
          confidence: 0.3,
          evidence: ["once"],
          lastSeen: now - 1 * DAY_MS,
          alpha: 1,
          beta: 1,
        },
      ],
      patterns: [],
      workflows: [],
    });

    expect(data.preferences).toHaveLength(1);
  });

  it("respects custom staleDays and minEvidence config", async () => {
    const { mgr, CONFIG } = await makeManager();
    CONFIG.userProfileStaleDays = 1;
    CONFIG.userProfileMinEvidenceForRetention = 5;

    const now = Date.now();
    const { data } = mgr.decayInMemory({
      preferences: [
        {
          category: "style",
          description: "custom threshold",
          confidence: 0.4,
          evidence: ["a", "b", "c", "d"],
          lastSeen: now - 2 * DAY_MS,
          alpha: 10,
          beta: 1,
        },
      ],
      patterns: [],
      workflows: [],
    });

    // 4 evidence < 5 and age > 1 day → removed (not the old hardcoded 30-day/alpha gate)
    expect(data.preferences).toHaveLength(0);
  });

  it("migrates confidence 1 continuously instead of dropping it to 0.6", async () => {
    const { mgr, CONFIG } = await makeManager();
    CONFIG.userProfileStaleDays = 2;
    CONFIG.userProfileMinEvidenceForRetention = 3;

    const { data } = mgr.decayInMemory({
      preferences: [
        {
          category: "style",
          description: "maximum confidence",
          confidence: 1,
          evidence: ["a", "b", "c"],
          frequency: 1,
          lastSeen: Date.now(),
        },
      ],
      patterns: [],
      workflows: [],
    });

    expect(data.preferences[0]?.confidence).toBeGreaterThan(0.98);
  });
});
