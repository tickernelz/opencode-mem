import { describe, expect, it } from "bun:test";
import { stripProfileEmbeddings, toPublicProfileData } from "../src/user-profile/profile-utils.js";

function sampleProfile() {
  return {
    preferences: [{ description: "a", centroid: [1, 2], anchor: [3, 4], confidence: 0.5 }],
    patterns: [{ description: "b", centroid: [1], anchor: [2], frequency: 3 }],
    workflows: [{ description: "c", centroid: [1], anchor: [2], steps: ["x"] }],
  };
}

describe("stripProfileEmbeddings", () => {
  it("removes centroid and anchor from every item type", () => {
    const data = sampleProfile();

    const result = stripProfileEmbeddings(data);

    expect(result).toBe(data);
    for (const key of ["preferences", "patterns", "workflows"] as const) {
      for (const item of result[key]) {
        expect(item.centroid).toBeUndefined();
        expect(item.anchor).toBeUndefined();
      }
    }
    expect(result.preferences[0].confidence).toBe(0.5);
    expect(result.patterns[0].frequency).toBe(3);
    expect(result.workflows[0].steps).toEqual(["x"]);
  });

  it("tolerates missing, malformed or non-object sections", () => {
    expect(stripProfileEmbeddings(undefined as any)).toBeUndefined();
    expect(stripProfileEmbeddings(null as any)).toBeNull();
    expect(stripProfileEmbeddings({} as any)).toEqual({});
    expect(stripProfileEmbeddings({ preferences: "not-an-array" } as any)).toEqual({
      preferences: "not-an-array",
    });
    expect(() => stripProfileEmbeddings({ patterns: [null, 1, "x"] } as any)).not.toThrow();
  });
});

describe("toPublicProfileData", () => {
  it("clones before stripping so the original keeps embeddings", () => {
    const data = sampleProfile();

    const result = toPublicProfileData(data);

    expect(result).not.toBe(data);
    expect(result.preferences[0]).not.toBe(data.preferences[0]);
    expect(data.preferences[0].centroid).toEqual([1, 2]);
    expect(data.preferences[0].anchor).toEqual([3, 4]);
    expect(result.preferences[0].centroid).toBeUndefined();
    expect(result.preferences[0].anchor).toBeUndefined();
    expect(result.patterns[0].centroid).toBeUndefined();
    expect(result.workflows[0].anchor).toBeUndefined();
    expect(result.preferences[0].confidence).toBe(0.5);
  });

  it("serializes without centroid or anchor keys", () => {
    const json = JSON.stringify(toPublicProfileData(sampleProfile()));
    expect(json).not.toContain('"centroid"');
    expect(json).not.toContain('"anchor"');
    expect(json).toContain('"description":"a"');
  });
});
