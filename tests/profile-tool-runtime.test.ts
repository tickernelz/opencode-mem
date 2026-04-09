import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionManager } from "../src/services/sqlite/connection-manager.js";

const WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

let tmpDir: string;

function writeProjectConfig(config: Record<string, unknown>) {
  const opencodeDir = join(tmpDir, ".opencode");
  mkdirSync(opencodeDir, { recursive: true });
  writeFileSync(join(opencodeDir, "opencode-mem.json"), JSON.stringify(config), "utf-8");
}

async function createPlugin() {
  const { memoryClient } = await import("../src/services/client.js");
  mock.module("../src/services/client.js", async () => ({
    memoryClient: {
      ...memoryClient,
      isReady: async () => true,
      warmup: async () => {},
    },
  }));

  globalThis[WARMUP_KEY as keyof typeof globalThis] = true as any;

  const { OpenCodeMemPlugin } = await import(`../src/index.js?runtime=${Date.now()}`);
  return OpenCodeMemPlugin({
    directory: tmpDir,
    worktree: tmpDir,
    project: { id: "test-project" } as any,
    serverUrl: new URL("http://localhost:4096"),
    client: {
      path: { get: async () => ({ data: { state: join(tmpDir, "state") } }) },
      provider: { list: async () => ({ data: { connected: [] } }) },
      tui: null,
    } as any,
    $: (() => {
      throw new Error("not used in tests");
    }) as any,
  });
}

describe("memory tool profile runtime behavior", () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-runtime-"));
  });

  beforeEach(() => {
    const opencodeDir = join(tmpDir, ".opencode");
    if (existsSync(opencodeDir)) rmSync(opencodeDir, { recursive: true, force: true });
    mock.restore();
    delete globalThis[WARMUP_KEY as keyof typeof globalThis];

    const userProfilesDbPath = join(tmpDir, "data", "user-profiles.db");
    if (existsSync(userProfilesDbPath)) {
      const db = connectionManager.getConnection(userProfilesDbPath);
      try {
        db.run("DELETE FROM user_profile_changelogs");
        db.run("DELETE FROM user_profiles");
      } catch {}
    }
  });

  afterEach(() => {
    mock.restore();
    delete globalThis[WARMUP_KEY as keyof typeof globalThis];
  });

  afterAll(() => {
    connectionManager.closeAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects query in profile mode", async () => {
    writeProjectConfig({
      storagePath: join(tmpDir, "data"),
      userEmailOverride: "test@example.com",
      userNameOverride: "Test User",
      webServerEnabled: false,
      autoCaptureEnabled: false,
    });

    const plugin = await createPlugin();
    const result = JSON.parse(
      await plugin.tool.memory.execute({ mode: "profile", query: "jira" }, { sessionID: "s1" })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("query is not valid for profile mode");
  });

  it("writes a preference when content is provided and returns it on read", async () => {
    writeProjectConfig({
      storagePath: join(tmpDir, "data"),
      userEmailOverride: "test@example.com",
      userNameOverride: "Test User",
      webServerEnabled: false,
      autoCaptureEnabled: false,
    });

    const plugin = await createPlugin();

    const writeResult = JSON.parse(
      await plugin.tool.memory.execute(
        { mode: "profile", content: "Default Jira board is DOPS" },
        { sessionID: "s2" }
      )
    );
    expect(writeResult.success).toBe(true);

    const readResult = JSON.parse(
      await plugin.tool.memory.execute({ mode: "profile" }, { sessionID: "s2" })
    );
    expect(readResult.success).toBe(true);
    expect(
      readResult.profile.preferences.some(
        (p: any) => p.description === "Default Jira board is DOPS"
      )
    ).toBe(true);
  });

  it("blocks blank content", async () => {
    writeProjectConfig({
      storagePath: join(tmpDir, "data"),
      userEmailOverride: "test@example.com",
      userNameOverride: "Test User",
      webServerEnabled: false,
      autoCaptureEnabled: false,
    });

    const plugin = await createPlugin();
    const result = JSON.parse(
      await plugin.tool.memory.execute({ mode: "profile", content: "   " }, { sessionID: "s3" })
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("content must not be blank");
  });

  it("blocks fully private content including adjacent redacted blocks", async () => {
    writeProjectConfig({
      storagePath: join(tmpDir, "data"),
      userEmailOverride: "test@example.com",
      userNameOverride: "Test User",
      webServerEnabled: false,
      autoCaptureEnabled: false,
    });

    const plugin = await createPlugin();
    const result = JSON.parse(
      await plugin.tool.memory.execute(
        {
          mode: "profile",
          content: "<private>a</private><private>b</private>",
        },
        { sessionID: "s4" }
      )
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Private content blocked");
  });

  it("errors when no user email can be resolved", async () => {
    writeProjectConfig({
      storagePath: join(tmpDir, "data"),
      webServerEnabled: false,
      autoCaptureEnabled: false,
    });

    mock.module("node:child_process", () => ({
      execSync: () => {
        throw new Error("git config unavailable");
      },
    }));

    const plugin = await createPlugin();
    const result = JSON.parse(
      await plugin.tool.memory.execute(
        { mode: "profile", content: "Default Jira board is DOPS" },
        { sessionID: "s5" }
      )
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Cannot save profile preference because no user email could be resolved"
    );
  });
});
