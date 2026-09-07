import { describe, expect, it } from "bun:test";
import { mergeCleanupIntoProfile } from "../src/services/api-handlers.js";
import { rebuildProfileUsing } from "../src/services/user-profile/ai-cleanup.js";
import type { UserProfileData } from "../src/services/user-profile/types.js";

function pref(description: string, category = "style") {
  return {
    category,
    description,
    confidence: 0.5,
    evidence: ["e1"],
  };
}

function baseProfile(descriptions: string[]): UserProfileData {
  return {
    preferences: descriptions.map((d) => pref(d)),
    patterns: [],
    workflows: [],
  };
}

describe("mergeCleanupIntoProfile (#237)", () => {
  it("preserves unselected items when applying a scoped cleanup", () => {
    const oldProfile = baseProfile([
      "keep-0",
      "keep-1",
      "scope-a",
      "scope-b",
      "keep-4",
      "keep-5",
      "keep-6",
      "keep-7",
      "keep-8",
      "keep-9",
    ]);

    const cleaned = baseProfile(["scope-a-merged"]);
    const result = mergeCleanupIntoProfile({
      currentProfile: oldProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_2", "pref_3"],
      acceptedMerged: [["pref_2", "pref_3"]],
      acceptedRemoved: [],
      allMerged: [{ ids: ["pref_2", "pref_3"], result: "scope-a-merged" }],
      allRemovedIds: [],
      explicitAcceptance: true,
    });

    const descs = result.preferences.map((p) => p.description);
    expect(descs).toContain("keep-0");
    expect(descs).toContain("keep-9");
    expect(descs).toContain("scope-a-merged");
    expect(descs).not.toContain("scope-a");
    expect(descs).not.toContain("scope-b");
    expect(descs.filter((d) => d.startsWith("keep-"))).toHaveLength(8);
  });

  it("restores items when a removal is rejected", () => {
    const oldProfile = baseProfile(["keep", "remove-me"]);
    const cleaned = baseProfile(["keep"]);

    const result = mergeCleanupIntoProfile({
      currentProfile: oldProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_0", "pref_1"],
      acceptedMerged: [],
      acceptedRemoved: [], // removal rejected
      allMerged: [],
      allRemovedIds: ["pref_1"],
      explicitAcceptance: true,
    });

    const descs = result.preferences.map((p) => p.description);
    expect(descs).toContain("keep");
    expect(descs).toContain("remove-me");
  });

  it("removes items when a removal is accepted", () => {
    const oldProfile = baseProfile(["keep", "remove-me", "outside"]);
    const cleaned = baseProfile(["keep"]);

    const result = mergeCleanupIntoProfile({
      currentProfile: oldProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_0", "pref_1"],
      acceptedMerged: [],
      acceptedRemoved: ["pref_1"],
      allMerged: [],
      allRemovedIds: ["pref_1"],
      explicitAcceptance: true,
    });

    const descs = result.preferences.map((p) => p.description);
    expect(descs).toContain("keep");
    expect(descs).toContain("outside");
    expect(descs).not.toContain("remove-me");
  });

  it("restores merge sources when a merge is rejected", () => {
    const oldProfile = baseProfile(["target", "source", "outside"]);
    const cleaned = baseProfile(["target-merged"]);

    const result = mergeCleanupIntoProfile({
      currentProfile: oldProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_0", "pref_1"],
      acceptedMerged: [], // merge rejected
      acceptedRemoved: [],
      allMerged: [{ ids: ["pref_0", "pref_1"], result: "target-merged" }],
      allRemovedIds: [],
      explicitAcceptance: true,
    });

    const descs = result.preferences.map((p) => p.description);
    expect(descs).toContain("outside");
    expect(descs).toContain("source");
    expect(descs).toContain("target");
    expect(descs).not.toContain("target-merged");
  });

  it("preserves items added after analysis", () => {
    const oldProfile = baseProfile(["scope-a", "keep"]);
    const currentProfile = baseProfile(["scope-a", "keep", "brand-new"]);
    const cleaned = baseProfile(["scope-a-clean"]);

    const result = mergeCleanupIntoProfile({
      currentProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_0"],
      acceptedMerged: [],
      acceptedRemoved: [],
      allMerged: [],
      allRemovedIds: [],
      explicitAcceptance: false,
    });

    const descs = result.preferences.map((p) => p.description);
    expect(descs).toContain("keep");
    expect(descs).toContain("brand-new");
    expect(descs).toContain("scope-a-clean");
    expect(descs).not.toContain("scope-a");
  });

  it("replaces the full profile when includeIds is unset", () => {
    const oldProfile = baseProfile(["a", "b", "c"]);
    const cleaned = baseProfile(["a-clean"]);

    const result = mergeCleanupIntoProfile({
      currentProfile: oldProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      acceptedMerged: [],
      acceptedRemoved: [],
      allMerged: [],
      allRemovedIds: ["pref_1", "pref_2"],
      explicitAcceptance: false,
    });

    expect(result.preferences.map((p) => p.description)).toEqual(["a-clean"]);
  });

  it("removes only the selected occurrence when descriptions are duplicated", () => {
    const oldProfile = baseProfile(["duplicate", "duplicate", "outside"]);
    const cleaned = baseProfile(["duplicate-cleaned"]);

    const result = mergeCleanupIntoProfile({
      currentProfile: oldProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_0"],
      acceptedMerged: [],
      acceptedRemoved: [],
      allMerged: [],
      allRemovedIds: [],
      explicitAcceptance: false,
    });

    expect(result.preferences.map((p) => p.description)).toEqual([
      "duplicate",
      "outside",
      "duplicate-cleaned",
    ]);
  });

  it("restores a rejected merge without duplicating items whose derived metadata changed", () => {
    const oldProfile = baseProfile(["duplicate", "duplicate", "outside"]);
    oldProfile.preferences[1]!.centroid = [0.1, 0.2];
    const currentProfile = structuredClone(oldProfile);
    currentProfile.preferences[1]!.centroid = undefined;
    const cleaned = baseProfile(["duplicate"]);

    const result = mergeCleanupIntoProfile({
      currentProfile,
      oldProfileData: oldProfile,
      cleanedData: cleaned,
      includeIds: ["pref_0", "pref_1"],
      acceptedMerged: [],
      acceptedRemoved: [],
      allMerged: [{ ids: ["pref_0", "pref_1"], result: "duplicate" }],
      allRemovedIds: [],
      explicitAcceptance: true,
    });

    expect(result.preferences).toHaveLength(3);
    expect(result.preferences.filter((p) => p.description === "duplicate")).toHaveLength(2);
    expect(result.preferences.map((p) => p.description)).toContain("outside");
  });
});

describe("rebuildProfileUsing (#237)", () => {
  it("does not preserve merge sources as unmentioned items", () => {
    const target = { id: "pref_0", ...pref("duplicate"), frequency: 2, lastSeen: 1 };
    const source = { id: "pref_1", ...pref("duplicate"), frequency: 3, lastSeen: 1 };
    const cleanedTarget = { id: "pref_0", ...pref("duplicate"), frequency: 5, lastSeen: 1 };

    const result = rebuildProfileUsing(
      { kept: [], merged: [["pref_0", "pref_1"]], removed: [] },
      new Map([["pref_0", cleanedTarget]]),
      new Map([
        ["pref_0", target],
        ["pref_1", source],
      ])
    );

    expect(result.preferences).toHaveLength(1);
    expect(result.preferences[0]?.description).toBe("duplicate");
  });
});
