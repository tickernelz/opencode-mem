import { beforeEach, describe, expect, it, mock } from "bun:test";

const profileContextModulePath = new URL(
  "../src/services/user-profile/profile-context.js",
  import.meta.url
).pathname;
const contextModulePath = new URL("../src/services/context.js", import.meta.url).pathname;
const configModulePath = new URL("../src/config.js", import.meta.url).pathname;

const getUserProfileContextMock = mock(() => null as string | null);

mock.module(configModulePath, () => ({
  CONFIG: {
    injectProfile: true,
    containerTagPrefix: "opencode",
    userEmailOverride: undefined,
    userNameOverride: undefined,
  },
}));

mock.module(profileContextModulePath, () => ({
  getUserProfileContext: getUserProfileContextMock,
}));

const { formatContextForPrompt } = await import(contextModulePath);

describe("Context Service", () => {
  beforeEach(() => {
    getUserProfileContextMock.mockReset();
    getUserProfileContextMock.mockReturnValue(null);
  });

  describe("formatContextForPrompt", () => {
    it("returns empty string when no memories", () => {
      const result = formatContextForPrompt(null, { results: [] });
      expect(result).toBe("");
    });

    it("formats project memories with similarity scores", () => {
      const result = formatContextForPrompt(null, {
        results: [
          { similarity: 0.923, memory: "First memory" },
          { similarity: 0.456, chunk: "Second chunk" },
        ],
      });

      expect(result).toContain("[MEMORY]");
      expect(result).toContain("Project Knowledge:");
      expect(result).toContain("- [92%] First memory");
      expect(result).toContain("- [46%] Second chunk");
    });

    it("includes profile context when userId is provided", () => {
      getUserProfileContextMock.mockReturnValue("User Preferences:\n- [style] concise");

      const result = formatContextForPrompt("user-123", {
        results: [{ similarity: 0.9, memory: "Project memory" }],
      });

      expect(getUserProfileContextMock).toHaveBeenCalledWith("user-123");
      expect(result).toContain("User Preferences:");
      expect(result).toContain("- [style] concise");
      expect(result).toContain("- [90%] Project memory");
    });
  });
});
