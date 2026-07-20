import { describe, expect, it } from "bun:test";
import {
  assertSafeScopeHash,
  extractScopeFromContainerTag,
  isValidScopeHash,
  resolveMemoryScope,
  tryExtractScopeFromContainerTag,
} from "../src/services/memory-scope.js";

const PROJECT_HASH = "a1b2c3d4e5f67890";
const USER_HASH = "b1b2c3d4e5f67890";

describe("memory scope helper", () => {
  it("parses project container tags", () => {
    expect(extractScopeFromContainerTag(`opencode_project_${PROJECT_HASH}`)).toEqual({
      scope: "project",
      hash: PROJECT_HASH,
    });
  });

  it("parses user container tags", () => {
    expect(extractScopeFromContainerTag(`opencode_user_${USER_HASH}`)).toEqual({
      scope: "user",
      hash: USER_HASH,
    });
  });

  it("resolves all-projects scope to empty project hash", () => {
    expect(resolveMemoryScope("all-projects", `opencode_project_${PROJECT_HASH}`)).toEqual({
      scope: "project",
      hash: "",
    });
  });

  it("validates scope hash format", () => {
    expect(isValidScopeHash(PROJECT_HASH)).toBe(true);
    expect(isValidScopeHash("abc123")).toBe(false);
    expect(isValidScopeHash("gggggggggggggggg")).toBe(false);
  });

  it("rejects container tags with invalid hash", () => {
    expect(() => extractScopeFromContainerTag("opencode_project_abc123")).toThrow(
      /16 lowercase hex/
    );
  });

  it("rejects container tags with path traversal segments", () => {
    expect(() =>
      extractScopeFromContainerTag("opencode_project_abcd1234567890ef/../../evil")
    ).toThrow(/16 lowercase hex/);
  });

  it("assertSafeScopeHash throws for invalid hashes", () => {
    expect(() => assertSafeScopeHash("../outside")).toThrow(/Invalid scope hash/);
  });

  it("tryExtractScopeFromContainerTag returns null for legacy tags", () => {
    expect(tryExtractScopeFromContainerTag("opencode_project_abc")).toBeNull();
    expect(tryExtractScopeFromContainerTag(`opencode_project_${PROJECT_HASH}`)).toEqual({
      scope: "project",
      hash: PROJECT_HASH,
    });
  });
});
