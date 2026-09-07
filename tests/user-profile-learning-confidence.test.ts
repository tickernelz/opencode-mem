import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createUserProfileAnalysisSchema,
  createUserProfileToolSchema,
  shouldRunAutomaticProfileCleanup,
  USER_PROFILE_LLM_CONFIDENCE_MAX,
} from "../src/services/user-memory-learning.js";
import { UserProfileValidator } from "../src/services/ai/validators/user-profile-validator.js";

describe("user-profile-learning confidence schema (#231)", () => {
  const schema = createUserProfileAnalysisSchema(z);

  const baseProfile = {
    preferences: [
      {
        category: "style",
        description: "Prefers concise answers",
        confidence: 0.8,
        evidence: ["please keep it short"],
      },
    ],
    patterns: [],
    workflows: [],
  };

  it("accepts confidence values above 0.5 (Groq Llama native 0–1 scale)", () => {
    const parsed = schema.parse(baseProfile);
    expect(parsed.preferences[0]?.confidence).toBe(0.8);
  });

  it("accepts confidence at the upper bound of 1", () => {
    const parsed = schema.parse({
      ...baseProfile,
      preferences: [{ ...baseProfile.preferences[0], confidence: 1 }],
    });
    expect(parsed.preferences[0]?.confidence).toBe(1);
  });

  it("rejects confidence above 1", () => {
    expect(() =>
      schema.parse({
        ...baseProfile,
        preferences: [{ ...baseProfile.preferences[0], confidence: 1.1 }],
      })
    ).toThrow();
  });

  it("exposes matching JSON-schema maximum for the external tool path", () => {
    const jsonSchema = createUserProfileToolSchema(false).function.parameters;

    expect(USER_PROFILE_LLM_CONFIDENCE_MAX).toBe(1);
    expect(jsonSchema.properties?.preferences?.items?.properties?.confidence?.minimum).toBe(0);
    expect(jsonSchema.properties?.preferences?.items?.properties?.confidence?.maximum).toBe(
      USER_PROFILE_LLM_CONFIDENCE_MAX
    );
  });

  it("rejects out-of-range confidence during provider response validation", () => {
    expect(
      UserProfileValidator.validate({
        ...baseProfile,
        preferences: [{ ...baseProfile.preferences[0], confidence: 1.1 }],
      }).valid
    ).toBe(false);
    expect(UserProfileValidator.validate(baseProfile).valid).toBe(true);
  });

  it("schedules automatic cleanup only when a prompt interval is crossed", () => {
    expect(shouldRunAutomaticProfileCleanup(90, 10, 100)).toBe(true);
    expect(shouldRunAutomaticProfileCleanup(100, 10, 100)).toBe(false);
  });
});
