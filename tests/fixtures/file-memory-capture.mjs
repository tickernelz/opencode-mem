import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const directory = process.argv[2];
const mode = process.argv[3];
mkdirSync(join(directory, "src"));
writeFileSync(join(directory, ".opencode-mem-project"), "");
for (const file of ["auth.ts", "other.ts", "failed.ts", "private.ts", "incidental.ts"])
  writeFileSync(join(directory, "src", file), "// fixture\n");
// Config may create its template on a clean test machine; reserve stdout for
// this fixture's single JSON result even when it runs before other tests.
const print = console.log;
let CONFIG;
try {
  console.log = () => {};
  ({ CONFIG } = await import(moduleUrl("config")));
} finally {
  console.log = print;
}
Object.assign(CONFIG, {
  storagePath: join(directory, "storage"),
  memoryBackend: mode === "markdown" ? "markdown" : "database",
  markdownPath: mode === "markdown" ? join(directory, "vault") : undefined,
  autoCaptureMaxRetries: 1,
  autoCaptureProviderStatus: { ready: true },
  autoCaptureLanguage: "en",
  opencodeProvider: "synthetic",
  opencodeModel: "synthetic",
  memoryModel: "",
  memoryApiUrl: "",
  showAutoCaptureToasts: false,
  showErrorToasts: false,
  updateOnCaptureEnabled: false,
});
CONFIG.chatMessage.fileAwareRecall = mode !== "disabled";
const rows = [];
const providerRequests = [];
mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (content, tag, metadata) => {
      rows.push({ content, tag, metadata });
      return { success: true, id: metadata.promptId };
    },
  },
}));
mock.module(moduleUrl("services/tags"), () => ({
  getTags: () => ({
    project: { tag: "opencode_project_abcdef1234567890", projectPath: directory },
  }),
}));
mock.module(moduleUrl("services/logger"), () => ({
  log() {},
  safeLog() {},
  serializeError: (error) => ({ error: String(error) }),
}));
mock.module(moduleUrl("services/ai/opencode-provider-loader"), () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      providerRequests.push(userPrompt);
      return {
        summary:
          mode === "unnamed"
            ? "The helper requires a cookie before checking permissions."
            : `The helper in \`${providerRequests.length === 1 ? "src/auth.ts" : "src/other.ts"}\` requires a cookie before checking permissions.`,
        type: "bug-fix",
        tags: [],
      };
    },
  }),
}));
const { userPromptManager: mgr } = await import(
  moduleUrl("services/user-prompt/user-prompt-manager")
);
const { tursoConnectionManager } = await import(moduleUrl("services/turso/connection-manager"));
const { performAutoCapture } = await import(moduleUrl("services/auto-capture"));
const { matchesFileMemory } = await import(moduleUrl("services/file-memory-association"));
const first = await mgr.savePrompt("session", "u1", directory, "Fix the helper");
if (mode === "queued") await mgr.savePrompt("session", "u2", directory, "Fix the other helper");
if (mode === "replay" || mode === "fallback") {
  await mgr.saveCaptureEvidence(
    first,
    directory,
    "tool",
    "read src/auth.ts: the helper requires a cookie"
  );
  await mgr.markCaptureEvidenceReady("session", directory);
}
const tool = (id, path, status = "completed", extras = {}) => ({
  type: "tool",
  id,
  name: "read",
  state: { status, input: { path }, content: [{ type: "text", text: "source contents" }] },
  ...extras,
});
const transcript = [
  { info: { id: "u1", role: "user" }, parts: [] },
  {
    info: { id: "a1", role: "assistant" },
    parts: [
      tool("read-auth", join(directory, "src/auth.ts")),
      tool("read-auth-repeat", join(directory, "src/auth.ts")),
      tool("read-incidental", join(directory, "src/incidental.ts")),
      tool("read-failed", join(directory, "src/failed.ts"), "error"),
      tool("read-ignored", join(directory, "src/private.ts"), "completed", { ignored: true }),
    ],
  },
  { info: { id: "u2", role: "user" }, parts: [] },
  {
    info: { id: "a2", role: "assistant" },
    parts: [tool("read-other", join(directory, "src/other.ts"))],
  },
];
let hostReads = 0;
const ctx = {
  fileObservationEnvironment: mode === "workspace" ? "workspace" : "local",
  client: {
    session: {
      messages: async () => {
        hostReads++;
        if (mode === "fallback") throw { name: "Session.NotFoundError" };
        return { data: transcript };
      },
    },
    tui: { showToast: async () => ({}) },
  },
};
await performAutoCapture(ctx, "session", directory, { preferSavedEvidence: mode === "replay" });
console.log(
  JSON.stringify({
    rows,
    hostReads,
    providerCalls: providerRequests.length,
    matches: rows.map((row) =>
      row.metadata.observedFiles
        ? matchesFileMemory(row.metadata, row.content, row.metadata.observedFiles)
        : false
    ),
  })
);
await tursoConnectionManager.closeAll();
