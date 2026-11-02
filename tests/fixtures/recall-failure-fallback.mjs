import { mock } from "bun:test";
const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
mock.module(moduleUrl("config"), () => ({ CONFIG: { injectProfile: false } }));
mock.module(moduleUrl("services/logger"), () => ({ log() {} }));
mock.module(moduleUrl("services/user-profile/profile-context"), () => ({
  getUserProfileContext: async () => "",
}));
const now = Date.UTC(2026, 10, 2);
Date.now = () => now;
const recent = [
  {
    id: "recent",
    summary: "recent body",
    createdAt: "2026-11-01",
    projectName: "project",
    metadata: { sessionID: "previous" },
  },
];
const semantic = {
  id: "semantic",
  memory: "semantic body",
  similarity: 0.75,
  createdAt: now,
  containerTag: "project",
};
let scenario;
let calls;
mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    listMemories: async (...args) => {
      calls.list.push(args);
      if (scenario.list === "throw") throw new Error("recent client unavailable");
      if (scenario.list === "failure")
        return { success: false, error: "recent client unavailable" };
      return { success: true, memories: scenario.list === "empty" ? [] : recent };
    },
    searchMemories: async (...args) => {
      calls.search.push(args);
      if (scenario.search === "throw") throw new Error("semantic client unavailable");
      if (scenario.search === "failure")
        return { success: false, error: "semantic client unavailable" };
      const results =
        scenario.search === "filtered"
          ? [
              { ...semantic, sessionId: "session" },
              { ...semantic, id: "old", createdAt: now - 10 * 86400000 },
            ]
          : scenario.search === "empty"
            ? []
            : [semantic];
      return {
        success: true,
        results,
        ...(scenario.warning ? { warnings: ["One shard could not be searched"] } : {}),
      };
    },
  },
}));
globalThis.fetch = () => {
  throw new Error("Network forbidden in fixture");
};
const { loadRecallMemories } = await import(moduleUrl("services/memory-recall"));
const { formatContextForPrompt } = await import(moduleUrl("services/context"));
const defaults = {
  containerTag: "project",
  sessionID: "session",
  queryText: " query ",
  maxMemories: 3,
  recall: "relevant",
  recallScope: "default",
  defaultScope: "project",
  excludeCurrentSession: true,
  maxAgeDays: 2,
  similarityThreshold: 0.6,
};
const scenarios = {
  failed: { search: "failure" },
  thrown: { search: "throw" },
  bothFailed: { search: "failure", recall: "both" },
  bothThrown: { search: "throw", recall: "both" },
  bothFailedEmpty: { search: "failure", recall: "both", list: "empty" },
  empty: { search: "empty" },
  filtered: { search: "filtered" },
  partial: { warning: true },
  partialEmpty: { search: "empty", warning: true },
  fallbackFailed: { search: "failure", list: "failure" },
  fallbackThrown: { search: "failure", list: "throw" },
  bothFallbackThrown: { search: "throw", recall: "both", list: "throw" },
  recent: { recall: "recent", search: "throw" },
  missingQuery: { queryText: null, search: "throw" },
  bothMissingQuery: { recall: "both", queryText: " ", search: "throw" },
  bothEmpty: { recall: "both", search: "empty" },
  bothSuccess: { recall: "both" },
  full: { recall: "both", maxMemories: 1 },
  zero: { maxMemories: 0, search: "throw" },
  zeroBoth: { recall: "both", maxMemories: 0, search: "throw" },
  zeroRecent: { recall: "recent", maxMemories: 0 },
  allProjects: { search: "failure", defaultScope: "all-projects" },
  explicitProject: { search: "failure", defaultScope: "all-projects", recallScope: "project" },
  disabledFilters: { search: "failure", excludeCurrentSession: false, maxAgeDays: 0 },
};
const output = {};
for (const [name, value] of Object.entries(scenarios)) {
  scenario = value;
  calls = { search: [], list: [] };
  try {
    const memories = await loadRecallMemories({ ...defaults, ...value });
    output[name] = {
      memories,
      calls,
      context: await formatContextForPrompt(null, { results: memories }),
    };
  } catch (error) {
    output[name] = { error: String(error), calls };
  }
}
console.log(JSON.stringify(output));
