import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cleanupServiceUrl = new URL("../src/services/cleanup-service.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const readyUrl = new URL("../src/services/turso/ready.js", import.meta.url).href;
const shardManagerUrl = new URL("../src/services/turso/shard-manager.js", import.meta.url).href;
const vectorSearchUrl = new URL("../src/services/turso/vector-search.js", import.meta.url).href;
const connectionManagerUrl = new URL("../src/services/turso/connection-manager.js", import.meta.url)
  .href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const aiProviderFactoryUrl = new URL("../src/services/ai/ai-provider-factory.js", import.meta.url)
  .href;
const errorClassifiersUrl = new URL("../src/services/turso/error-classifiers.js", import.meta.url)
  .href;

function runCleanupScenario(opts: {
  promptThrowsIdxDelete?: boolean;
  vacuumError?: "unsupported" | "busy" | null;
  deleteVectorThrowsIdxDelete?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-cleanup-resilience-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const promptThrows = opts.promptThrowsIdxDelete ?? false;
  const vacuumError = opts.vacuumError ?? null;
  const deleteThrows = opts.deleteVectorThrowsIdxDelete ?? false;

  const script = `
import { mock } from "bun:test";

const logs = [];
let vacuumCalls = 0;

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCleanupEnabled: true,
    autoCleanupRetentionDays: 30,
    storagePath: ${JSON.stringify(dir)},
    dreaming: { trashRetentionDays: 30 },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: (msg, meta) => { logs.push({ msg, meta }); },
  safeLog: () => {},
  serializeError: (error) => ({ error: String(error) }),
}));

mock.module(${JSON.stringify(readyUrl)}, () => ({
  ensureTursoReady: async () => {},
}));

mock.module(${JSON.stringify(errorClassifiersUrl)}, () => ({
  isVacuumUnsupportedError: (error) => String(error).includes("experimental"),
  isIdxDeleteMismatchError: (error) => String(error).includes("IdxDelete"),
}));

mock.module(${JSON.stringify(shardManagerUrl)}, () => ({
  tursoShardManager: {
    getAllShards: async (kind) =>
      kind === "project"
        ? [{ id: "proj-1", dbPath: ${JSON.stringify(join(dir, "proj.db"))} }]
        : [],
    ensureShardSchema: async () => {},
    decrementVectorCount: async () => {},
  },
}));

mock.module(${JSON.stringify(vectorSearchUrl)}, () => ({
  tursoVectorSearch: {
    deleteVector: async () => {
      if (${deleteThrows}) {
        throw new Error("Corrupt database: IdxDelete: no matching index entry found for key");
      }
    },
    purgeDeletedBefore: async () => [],
  },
}));

mock.module(${JSON.stringify(connectionManagerUrl)}, () => ({
  tursoConnectionManager: {
    getConnection: async () => ({
      all: async (sql) => {
        if (String(sql).includes("is_pinned")) return [];
        if (String(sql).includes("updated_at")) {
          return [{ id: "mem-1", container_tag: "x_project_y", is_pinned: 0 }];
        }
        return [];
      },
    }),
  },
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    deleteOldPrompts: async () => {
      if (${promptThrows}) {
        throw new Error("Corrupt database: IdxDelete: no matching index entry found for key");
      }
      return { deleted: 0, linkedMemoryIds: [] };
    },
    vacuum: async () => {
      vacuumCalls += 1;
      if (${JSON.stringify(vacuumError)} === "unsupported") {
        throw new Error("Parse error: VACUUM is an experimental feature");
      }
      if (${JSON.stringify(vacuumError)} === "busy") {
        throw new Error("database is locked");
      }
    },
  },
}));

mock.module(${JSON.stringify(aiProviderFactoryUrl)}, () => ({
  AIProviderFactory: {
    cleanupExpiredSessions: async () => 0,
  },
}));

const { cleanupService, resetVacuumUnsupportedForTests } = await import(${JSON.stringify(cleanupServiceUrl)});
resetVacuumUnsupportedForTests();
const result1 = await cleanupService.runCleanup();
const result2 = await cleanupService.runCleanup();
console.log(JSON.stringify({ result1, result2, vacuumCalls, logs }));
`;

  writeFileSync(scriptPath, script);

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("cleanup resilience", () => {
  it("continues when deleteOldPrompts throws IdxDelete", () => {
    const result = runCleanupScenario({ promptThrowsIdxDelete: true });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.parsed.result1.deletedCount).toBeGreaterThanOrEqual(0);
    const stepLog = result.parsed.logs.find(
      (l: { msg: string }) => l.msg === "Cleanup: step failed"
    );
    expect(stepLog?.meta?.step).toBe("deleteOldPrompts");
  });

  it("treats IdxDelete from deleteVector as non-fatal via catch path", () => {
    const result = runCleanupScenario({ deleteVectorThrowsIdxDelete: true });
    expect(result.exitCode).toBe(0);
    expect(result.parsed.result1).toBeTruthy();
  });

  it("logs VACUUM unsupported once and skips subsequent vacuum calls", () => {
    const result = runCleanupScenario({ vacuumError: "unsupported" });
    expect(result.exitCode).toBe(0);
    expect(result.parsed.vacuumCalls).toBe(1);
    const unsupported = result.parsed.logs.filter(
      (l: { msg: string }) => l.msg === "Cleanup: VACUUM skipped (unsupported by Turso backend)"
    );
    expect(unsupported).toHaveLength(1);
    const busy = result.parsed.logs.filter(
      (l: { msg: string }) => l.msg === "Cleanup: VACUUM skipped (DB busy)"
    );
    expect(busy).toHaveLength(0);
  });

  it("keeps DB busy label for lock errors", () => {
    const result = runCleanupScenario({ vacuumError: "busy" });
    expect(result.exitCode).toBe(0);
    const busy = result.parsed.logs.filter(
      (l: { msg: string }) => l.msg === "Cleanup: VACUUM skipped (DB busy)"
    );
    expect(busy.length).toBeGreaterThanOrEqual(1);
  });
});
