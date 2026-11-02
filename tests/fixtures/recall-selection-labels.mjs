import { mock } from "bun:test";
const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
mock.module(moduleUrl("config"), () => ({ CONFIG: { injectProfile: false } }));
mock.module(moduleUrl("services/logger"), () => ({ log() {} }));
mock.module(moduleUrl("services/user-profile/profile-context"), () => ({
  getUserProfileContext: async () => "",
}));
const recent = [
  { id: "shared", summary: "shared body", createdAt: "2026-10-31", projectName: "project" },
  { id: "recent", summary: "recent body", createdAt: "2026-10-30", projectName: "project" },
];
let searchCalls = 0;
mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: recent }),
    searchMemories: async () => {
      searchCalls++;
      return {
        success: true,
        results: [
          {
            id: "shared",
            memory: "shared body",
            similarity: 0.742,
            containerTag: "project",
            createdAt: "2026-10-31",
            projectName: "project",
          },
        ],
      };
    },
  },
}));
const { loadRecallMemories } = await import("../../src/services/memory-recall.js");
const { formatContextForPrompt } = await import("../../src/services/context.js");
const defaults = {
  containerTag: "project",
  sessionID: "session",
  queryText: "query",
  maxMemories: 3,
  recall: "recent",
  recallScope: "project",
  defaultScope: "project",
  excludeCurrentSession: true,
  similarityThreshold: 0.6,
};
const output = {};
for (const [name, overrides] of Object.entries({
  recent: {},
  fallback: { recall: "relevant", queryText: null },
  bothFallback: { recall: "both", queryText: " " },
  relevant: { recall: "relevant" },
  both: { recall: "both" },
  boosted: { recall: "relevant", recallScope: "all-projects" },
})) {
  const memories = await loadRecallMemories({ ...defaults, ...overrides });
  output[name] = { memories, context: await formatContextForPrompt(null, { results: memories }) };
}
output.searchCalls = searchCalls;
console.log(JSON.stringify(output));
