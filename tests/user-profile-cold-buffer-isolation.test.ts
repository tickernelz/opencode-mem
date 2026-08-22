import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";

let tmpDir: string;

async function makeManager() {
  const { CONFIG } = await import("../src/config.js");
  CONFIG.storagePath = tmpDir;
  CONFIG.userProfileEmbeddingMinDescriptionLength = 5;
  const { UserProfileManager } =
    await import("../src/services/user-profile/user-profile-manager.js");
  return { mgr: new UserProfileManager(), CONFIG };
}

// Embedding not warmed up → mergeItems buffers non-explicit items (cold start).
const coldEmbed = { isWarmedUp: false } as any;
// Warmed up → buffered items drain into the merge. embed() is only used to seed a
// centroid on append; existing is empty here so no cosine comparison runs.
const warmEmbed = {
  isWarmedUp: true,
  embed: async () => new Float32Array(8).fill(0.25),
} as any;

const empty = () => ({ preferences: [], patterns: [], workflows: [] });

describe("cold buffer per-user isolation (correctness #1)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-coldbuf-"));
  });

  afterEach(async () => {
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("does not drain one user's buffered items into another user's merge", async () => {
    const { mgr } = await makeManager();

    // Cold start: each user's observation is buffered under its own profileId.
    await mgr.mergeProfileData(
      empty(),
      { preferences: [{ category: "style", description: "A prefers tabs over spaces" }] },
      coldEmbed,
      "profile_A"
    );
    await mgr.mergeProfileData(
      empty(),
      { preferences: [{ category: "style", description: "B prefers spaces over tabs" }] },
      coldEmbed,
      "profile_B"
    );

    // Warm merge for B must drain only B's bucket, never A's.
    const mergedB = await mgr.mergeProfileData(
      empty(),
      { preferences: [] },
      warmEmbed,
      "profile_B"
    );
    const descsB = mergedB.preferences.map((p: any) => p.description);
    expect(descsB).toContain("B prefers spaces over tabs");
    expect(descsB).not.toContain("A prefers tabs over spaces");

    // A's bucket is untouched by B's drain and drains only for A.
    const mergedA = await mgr.mergeProfileData(
      empty(),
      { preferences: [] },
      warmEmbed,
      "profile_A"
    );
    const descsA = mergedA.preferences.map((p: any) => p.description);
    expect(descsA).toContain("A prefers tabs over spaces");
    expect(descsA).not.toContain("B prefers spaces over tabs");
  });
});
