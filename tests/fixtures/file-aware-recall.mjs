import { mock } from "bun:test";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
mock.module(moduleUrl("config"), () => ({ CONFIG: { injectProfile: false } }));
mock.module(moduleUrl("services/logger"), () => ({ log() {} }));
mock.module(moduleUrl("services/user-profile/profile-context"), () => ({
  getUserProfileContext: async () => "",
}));
let fileFailure = false;
let fileThrows = false;
let semanticFailure = false;
let semanticResults = [];
let fileResults = [];
let fileCalls = [];
const known = {
  id: "known-gotcha",
  summary: "The retry handler must release the claim before rescheduling.",
  createdAt: "2026-11-01T00:00:00.000Z",
  projectName: "sample",
};
mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    searchMemories: async () => ({ success: !semanticFailure, results: semanticResults }),
    listMemories: async () => ({
      success: true,
      memories: [{ id: "recent", summary: "recent background" }],
    }),
    listFileMemories: async (...args) => {
      fileCalls.push(args);
      if (fileThrows) throw new Error("file query failed");
      return { success: !fileFailure, memories: fileResults };
    },
  },
}));
const { loadRecallMemories } = await import(moduleUrl("services/memory-recall"));
const { formatContextForPrompt } = await import(moduleUrl("services/context"));
const observedFiles = { version: 1, workspace: "a".repeat(64), paths: ["src/retry.ts"] };
const defaults = {
  containerTag: "project",
  sessionID: "current",
  queryText: "fix this",
  maxMemories: 3,
  recall: "relevant",
  recallScope: "all-projects",
  defaultScope: "project",
  excludeCurrentSession: true,
  maxAgeDays: 30,
  similarityThreshold: 0.6,
};
Date.now = () => Date.UTC(2026, 10, 5);
const output = {};
async function run(name, overrides = {}) {
  fileCalls = [];
  const memories = await loadRecallMemories({ ...defaults, ...overrides });
  output[name] = {
    memories,
    fileCalls,
    context: await formatContextForPrompt(null, { results: memories }),
  };
}
await run("vagueBaseline");
fileResults = [known];
await run("vagueWithFile", { observedFiles });
fileResults = [];
await run("unrelatedFile", { observedFiles });
semanticResults = [
  { id: "semantic-a", memory: "A", similarity: 0.8 },
  { id: "known-gotcha", memory: known.summary, similarity: 0.7 },
  { id: "semantic-c", memory: "C", similarity: 0.65 },
];
fileResults = [known];
await run("deduplicated", { observedFiles });
await run("oneSlot", { observedFiles, maxMemories: 1 });
await run("disabledCount", { observedFiles, maxMemories: 0 });
fileFailure = true;
await run("fileFailure", { observedFiles });
fileFailure = false;
fileThrows = true;
await run("fileThrows", { observedFiles });
fileThrows = false;
semanticFailure = true;
await run("semanticFailure", { observedFiles });
await run("disabledFilters", {
  observedFiles,
  excludeCurrentSession: false,
  maxAgeDays: undefined,
});
console.log(JSON.stringify(output));
