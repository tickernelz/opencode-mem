import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ScenarioInput = {
  config: Record<string, unknown>;
  args: Record<string, unknown>;
  sessionID?: string;
  mockGitConfigUnavailable?: boolean;
  readAfterWrite?: boolean;
  /** Hold the real learning lock before the tool write (proves fail-closed contention). */
  holdLearningLockBeforeWrite?: boolean;
  /** Mock the lock to count acquire/release (proves the write path takes it). */
  trackLearningLock?: boolean;
};

const tempDirs: string[] = [];
const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/memory/client.js", import.meta.url).href;
const userProfileManagerUrl = new URL(
  "../src/user-profile/user-profile-manager.js",
  import.meta.url
).href;
const learningLockUrl = new URL("../src/user-profile/learning-lock.js", import.meta.url).href;

function runScenario(input: ScenarioInput) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-runtime-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tmpDir = ${JSON.stringify(dir)};
const WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");
mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
writeFileSync(
  join(tmpDir, ".opencode", "opencode-mem.json"),
  JSON.stringify(${JSON.stringify(input.config)}),
  "utf-8"
);

const profiles = new Map();
const changelogs = [];
function cleanProfileData(profileData) {
  return {
    preferences: Array.isArray(profileData?.preferences) ? profileData.preferences : [],
    patterns: Array.isArray(profileData?.patterns) ? profileData.patterns : [],
    workflows: Array.isArray(profileData?.workflows) ? profileData.workflows : [],
  };
}

mock.module(${JSON.stringify(userProfileManagerUrl)}, () => ({
  userProfileManager: {
    getActiveProfile(userId) {
      return profiles.get(userId) ?? null;
    },
    createProfile(userId, displayName, userName, userEmail, profileData) {
      const id = \`profile_\${profiles.size + 1}\`;
      profiles.set(userId, {
        id,
        userId,
        displayName,
        userName,
        userEmail,
        profileData: JSON.stringify(cleanProfileData(profileData)),
        version: 1,
        createdAt: Date.now(),
        lastAnalyzedAt: Date.now(),
        totalPromptsAnalyzed: 0,
        isActive: true,
      });
      changelogs.push({ profileId: id, version: 1 });
      return id;
    },
    updateProfile(profileId, profileData) {
      for (const profile of profiles.values()) {
        if (profile.id === profileId) {
          profile.profileData = JSON.stringify(cleanProfileData(profileData));
          profile.version += 1;
        }
      }
    },
    mergeProfileData(existingData, newData) {
      const preferences = [...(existingData.preferences ?? [])];
      for (const pref of newData.preferences ?? []) {
        const existing = preferences.find((item) => item.description === pref.description);
        if (existing) {
          existing.confidence = Math.max(existing.confidence ?? 0, pref.confidence ?? 0);
          existing.lastSeen = pref.lastSeen;
        } else {
          preferences.push(pref);
        }
      }
      return {
        preferences,
        patterns: existingData.patterns ?? [],
        workflows: existingData.workflows ?? [],
      };
    },
  },
}));

${
  input.trackLearningLock
    ? `const lockStats = { acquireCount: 0, releaseCount: 0 };
mock.module(${JSON.stringify(learningLockUrl)}, () => ({
  tryAcquireProfileLearningLock: async () => {
    lockStats.acquireCount += 1;
    return async () => {
      lockStats.releaseCount += 1;
    };
  },
  isProfileLearningLockHeld: async () => false,
}));`
    : ""
}

${
  input.mockGitConfigUnavailable
    ? `mock.module("${new URL("../src/memory/tags.js", import.meta.url).href}", () => ({
  getTags: () => ({
    user: {
      tag: "opencode_user_unknown",
      displayName: "anonymous",
      userName: "anonymous",
      userEmail: undefined,
    },
    project: {
      tag: "opencode_project_test",
      displayName: tmpDir,
      projectPath: tmpDir,
      projectName: "test-project",
    },
  }),
}));`
    : ""
}

const { memoryClient } = await import(${JSON.stringify(clientUrl)});
mock.module(${JSON.stringify(clientUrl)}, async () => ({
  memoryClient: {
    ...memoryClient,
    isReady: async () => true,
    warmup: async () => {},
    close: () => {},
  },
}));

globalThis[WARMUP_KEY] = true;
const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({
  directory: tmpDir,
  worktree: tmpDir,
  project: { id: "test-project" },
  serverUrl: new URL("http://localhost:4096"),
  client: {
    path: { get: async () => ({ data: { state: join(tmpDir, "state") } }) },
    provider: { list: async () => ({ data: { connected: [] } }) },
    tui: null,
  },
  $: () => {
    throw new Error("not used in tests");
  },
});

let heldLockRelease = null;
if (${JSON.stringify(Boolean(input.holdLearningLockBeforeWrite))}) {
  const { tryAcquireProfileLearningLock } = await import(${JSON.stringify(learningLockUrl)});
  heldLockRelease = await tryAcquireProfileLearningLock(tmpDir);
  if (!heldLockRelease) {
    throw new Error("failed to hold learning lock for contention scenario");
  }
}

const writeResult = JSON.parse(
  await plugin.tool.memory.execute(${JSON.stringify(input.args)}, {
    sessionID: ${JSON.stringify(input.sessionID ?? "s1")},
  })
);

if (heldLockRelease) {
  await heldLockRelease();
  heldLockRelease = null;
}

let readResult = null;
if (${JSON.stringify(Boolean(input.readAfterWrite))}) {
  readResult = JSON.parse(
    await plugin.tool.memory.execute({ mode: "profile" }, {
      sessionID: ${JSON.stringify(input.sessionID ?? "s1")},
    })
  );
}

console.log(JSON.stringify({
  writeResult,
  readResult,
  lockStats: typeof lockStats !== "undefined" ? lockStats : null,
}));
`;

  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{"));

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: jsonLine ? JSON.parse(jsonLine) : null,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function profileConfig(overrides: Record<string, unknown> = {}) {
  return {
    storagePath: "./data",
    userEmailOverride: "test@example.com",
    userNameOverride: "Test User",
    webServerEnabled: false,
    autoCaptureEnabled: false,
    ...overrides,
  };
}

describe("memory tool profile runtime behavior", () => {
  it("rejects query in profile mode", () => {
    const result = runScenario({
      config: profileConfig(),
      args: { mode: "profile", query: "jira" },
      sessionID: "s1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed.writeResult.success).toBe(false);
    expect(result.parsed.writeResult.error).toContain("query is not valid for profile mode");
  });

  it("writes a preference when content is provided and returns it on read", () => {
    const result = runScenario({
      config: profileConfig(),
      args: { mode: "profile", content: "Default Jira board is DOPS" },
      sessionID: "s2",
      readAfterWrite: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed.writeResult.success).toBe(true);
    expect(result.parsed.readResult.success).toBe(true);
    expect(
      result.parsed.readResult.profile.preferences.some(
        (p: any) => p.description === "Default Jira board is DOPS"
      )
    ).toBe(true);
  });

  it("blocks blank content", () => {
    const result = runScenario({
      config: profileConfig(),
      args: { mode: "profile", content: "   " },
      sessionID: "s3",
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed.writeResult.success).toBe(false);
    expect(result.parsed.writeResult.error).toBe("content must not be blank");
  });

  it("blocks fully private content including adjacent redacted blocks", () => {
    const result = runScenario({
      config: profileConfig(),
      args: {
        mode: "profile",
        content: "<private>a</private><private>b</private>",
      },
      sessionID: "s4",
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed.writeResult.success).toBe(false);
    expect(result.parsed.writeResult.error).toBe("Private content blocked");
  });

  it("errors when no user email can be resolved", () => {
    const result = runScenario({
      config: {
        storagePath: "./data",
        webServerEnabled: false,
        autoCaptureEnabled: false,
      },
      args: { mode: "profile", content: "Default Jira board is DOPS" },
      sessionID: "s5",
      mockGitConfigUnavailable: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    expect(result.parsed.writeResult.success).toBe(false);
    expect(result.parsed.writeResult.error).toContain(
      "Cannot save profile preference because no user email could be resolved"
    );
  });

  it("acquires and releases the profile learning lock on preference write", () => {
    const result = runScenario({
      config: profileConfig(),
      args: { mode: "profile", content: "Prefer short answers" },
      sessionID: "s6",
      trackLearningLock: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    expect(result.parsed.writeResult.success).toBe(true);
    expect(result.parsed.lockStats.acquireCount).toBe(1);
    expect(result.parsed.lockStats.releaseCount).toBe(1);
  });

  it("fails closed when the profile learning lock is already held", () => {
    const result = runScenario({
      config: profileConfig(),
      args: { mode: "profile", content: "Prefer short answers" },
      sessionID: "s7",
      holdLearningLockBeforeWrite: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    expect(result.parsed.writeResult.success).toBe(false);
    expect(result.parsed.writeResult.error).toContain("profile learning holds the lock");
  });
});
