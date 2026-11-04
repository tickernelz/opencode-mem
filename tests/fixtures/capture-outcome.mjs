import { mock } from "bun:test";
import { Database } from "bun:sqlite";
const src = process.env.SOURCE;
const { CONFIG } = await import(src + "config.js");
Object.assign(CONFIG, {
  storagePath: process.env.STORE,
  autoCaptureMaxRetries: 1,
  autoCaptureProviderStatus: { ready: true },
  autoCaptureLanguage: "en",
  opencodeProvider: "synthetic",
  opencodeModel: "synthetic",
  memoryModel: "",
  memoryApiUrl: "",
  showAutoCaptureToasts: false,
  showErrorToasts: false,
  updateOnCaptureEnabled: process.env.REWRITE === "true",
});
const raw = new Database(process.env.STORE + "/captured.db");
raw.run("CREATE TABLE captured (id TEXT PRIMARY KEY, content TEXT)");
const seen = [];
let updates = 0;
if (process.env.REWRITE === "true")
  raw.run("INSERT INTO captured VALUES (?,?)", ["existing", "Original auth finding"]);
mock.module(src + "services/client.js", () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    searchMemories: async () => ({
      success: true,
      results: [{ id: "existing", memory: "Original auth finding", similarity: 0.95 }],
    }),
    getMemoryById: async () => ({
      success: true,
      memory: { id: "existing", content: "Original auth finding", isPinned: false },
    }),
    updateMemory: async (id, data) => {
      updates++;
      raw.run("UPDATE captured SET content = ? WHERE id = ?", [data.content, id]);
      return { success: true };
    },
    addMemory: async (content, _tag, metadata) => {
      raw.run("INSERT INTO captured VALUES (?,?)", [metadata.promptId, content]);
      return { success: true, id: metadata.promptId };
    },
    close() {},
  },
}));
mock.module(src + "services/tags.js", () => ({
  getTags: () => ({ project: { tag: "synthetic", projectPath: "/synthetic" } }),
}));
mock.module(src + "services/logger.js", () => ({
  log() {},
  safeLog() {},
  serializeError: (e) => ({ error: String(e) }),
}));
mock.module(src + "services/ai/opencode-provider-loader.js", () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ systemPrompt, userPrompt }) => {
      seen.push({ systemPrompt, userPrompt });
      if (process.env.REWRITE === "true" && seen.length > 1)
        return { action: "update", targetId: "existing", content: "x".repeat(20000) };
      return {
        summary:
          process.env.OVERSIZED === "true"
            ? "x".repeat(20000)
            : "The first auth check failed; a rerun passed one test after the fix. Deployment remains unverified.",
        type: "bug-fix",
        tags: ["auth"],
      };
    },
  }),
}));
const { userPromptManager: mgr } = await import(
  src + "services/user-prompt/user-prompt-manager.js"
);
const { tursoConnectionManager } = await import(src + "services/turso/connection-manager.js");
const { performAutoCapture } = await import(src + "services/auto-capture.js");
const id = await mgr.savePrompt("s", "u", "/synthetic", "Fix auth and verify it");
const ctx = {
  client: {
    session: {
      messages: async () => ({
        data: [
          { info: { id: "u", role: "user" }, parts: [] },
          {
            info: { id: "a", role: "assistant" },
            parts: [
              { type: "text", text: "Everything works, including deployment." },
              {
                type: "tool",
                id: "first",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "test" },
                  content: [
                    { type: "text", text: "FAIL auth: 401. <private>hidden-password</private>" },
                  ],
                },
              },
              {
                type: "tool",
                id: "second",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "test" },
                  content: [
                    { type: "text", text: "PASS auth: 1 test passed; deployment not tested" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    },
    tui: { showToast: async () => ({}) },
  },
};
await performAutoCapture(ctx, "s", "/synthetic");
await performAutoCapture(ctx, "s", "/synthetic");
console.log(
  JSON.stringify({
    seen,
    updates,
    rows: raw.query("SELECT * FROM captured").all(),
    prompt: await mgr.getPromptById(id),
  })
);
raw.close();
await tursoConnectionManager.closeConnection(process.env.STORE + "/user-prompts.db");
