import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const apiHandlersUrl = new URL("../src/runtime/http/api-handlers.js", import.meta.url).href;
const userProfileManagerUrl = new URL(
  "../src/user-profile/user-profile-manager.js",
  import.meta.url
).href;
const tagsUrl = new URL("../src/memory/tags.js", import.meta.url).href;
const loggerUrl = new URL("../src/infra/logger.js", import.meta.url).href;
const userPromptManagerUrl = new URL(
  "../src/memory/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;

const profileWithEmbeddings = {
  preferences: [
    {
      id: "pref-1",
      description: "prefer TypeScript",
      confidence: 0.9,
      centroid: [0.1, 0.2, 0.3],
      anchor: [0.1, 0.2, 0.3],
    },
  ],
  patterns: [
    {
      id: "pat-1",
      description: "asks for diffs",
      frequency: 4,
      centroid: [0.4, 0.5],
      anchor: [0.4, 0.5],
    },
  ],
  workflows: [
    {
      id: "wf-1",
      description: "review then commit",
      frequency: 2,
      steps: ["review", "commit"],
      centroid: [0.6],
      anchor: [0.7],
    },
  ],
};

function runScenario(scriptBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-profile-strip-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const script = `
import { mock } from "bun:test";

const profileWithEmbeddings = ${JSON.stringify(profileWithEmbeddings)};

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
}));

mock.module(${JSON.stringify(userPromptManagerUrl)}, () => ({
  userPromptManager: {},
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    user: { userEmail: "user@example.com" },
  }),
}));

mock.module(${JSON.stringify(userProfileManagerUrl)}, () => ({
  userProfileManager: {
    getActiveProfile: async () => ({
      id: "profile_1",
      userId: "user@example.com",
      displayName: "User",
      userName: "user",
      userEmail: "user@example.com",
      version: 3,
      createdAt: Date.now(),
      lastAnalyzedAt: Date.now(),
      totalPromptsAnalyzed: 12,
      profileData: JSON.stringify(profileWithEmbeddings),
    }),
    getChangelogById: async () => ({
      id: "cl_1",
      version: 2,
      createdAt: Date.now(),
      profileDataSnapshot: JSON.stringify(profileWithEmbeddings),
    }),
  },
}));

const {
  handleGetUserProfile,
  handleGetProfileSnapshot,
} = await import(${JSON.stringify(apiHandlersUrl)});

function assertNoEmbeddings(profileData) {
  for (const key of ["preferences", "patterns", "workflows"]) {
    for (const item of profileData[key] ?? []) {
      if (item.centroid !== undefined || item.anchor !== undefined) {
        throw new Error(\`embedding leaked in \${key}\`);
      }
    }
  }
  const json = JSON.stringify(profileData);
  if (json.includes('"centroid"') || json.includes('"anchor"')) {
    throw new Error("embedding keys present in serialized profileData");
  }
}

${scriptBody}
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

describe("API profile responses strip embeddings", () => {
  it("handleGetUserProfile omits centroid/anchor", () => {
    const result = runScenario(`
const response = await handleGetUserProfile("user@example.com");
assertNoEmbeddings(response.data.profileData);
console.log(JSON.stringify({
  success: response.success,
  description: response.data.profileData.preferences[0].description,
}));
`);
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.success).toBe(true);
    expect(result.parsed?.description).toBe("prefer TypeScript");
  });

  it("handleGetProfileSnapshot omits centroid/anchor", () => {
    const result = runScenario(`
const response = await handleGetProfileSnapshot("cl_1");
assertNoEmbeddings(response.data.profileData);
console.log(JSON.stringify({
  success: response.success,
  version: response.data.version,
}));
`);
    expect(result.exitCode).toBe(0);
    expect(result.parsed?.success).toBe(true);
    expect(result.parsed?.version).toBe(2);
  });
});
