import { mock } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const moduleUrl = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
// macOS temporary directories can be reached through /var -> /private/var.
// Use canonical test roots; the production path gate rejects symlink aliases.
const fixtureDirectory = realpathSync(process.argv[2]);
const directory = join(fixtureDirectory, "project");
mkdirSync(join(directory, ".git"), { recursive: true });
writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
mkdirSync(join(directory, "src"));
const filePath = join(directory, "src", "auth.ts");
writeFileSync(filePath, "// source fixture\n");
const outsidePath = join(fixtureDirectory, "outside.ts");
writeFileSync(outsidePath, "// other project fixture\n");
const projectTag = "opencode_project_abcdef1234567890";
const config = {
  storagePath: join(fixtureDirectory, "storage"),
  databaseEncryptionEnabled: false,
  tursoMultiprocessWal: false,
  memoryBackend: "database",
  injectProfile: true,
  chatMessage: {
    enabled: true,
    injectOn: "first",
    maxMemories: 2,
    excludeCurrentSession: true,
    maxAgeDays: 30,
    filterInjectedPrompts: true,
    captureChildSessions: false,
    recall: "relevant",
    recallScope: "all-projects",
    fileAwareRecall: true,
  },
  memory: { defaultScope: "project" },
  similarityThreshold: 0.6,
  compaction: { enabled: false },
  autoCaptureEnabled: false,
  webServerEnabled: false,
  autoUpdate: { enabled: false },
  opencodeModel: "inherit",
};
let configured = true;
mock.module(moduleUrl("config"), () => ({
  CONFIG: config,
  initConfig() {},
  isConfigured: () => configured,
}));
const searchCalls = [];
const fileCalls = [];
const listCalls = [];
const profileCalls = [];
let fileBehavior = "match";
mock.module(moduleUrl("services/client"), () => ({
  memoryClient: {
    warmup: async () => {},
    close: async () => {},
    searchMemories: async (...args) => {
      searchCalls.push(args);
      return {
        success: true,
        results: [
          { id: "semantic-first", memory: `Recall for: ${args[0]}`, similarity: 0.8 },
          { id: "semantic-second", memory: "Secondary semantic result", similarity: 0.7 },
        ],
      };
    },
    listMemories: async (...args) => {
      listCalls.push(args);
      return { success: true, memories: [] };
    },
    listFileMemories: async (...args) => {
      fileCalls.push(args);
      if (["overlap", "overlapNovel"].includes(fileBehavior))
        return {
          success: true,
          memories: [
            { id: "semantic-second", summary: "Secondary semantic result" },
            ...(fileBehavior === "overlapNovel"
              ? [{ id: "file-gotcha", summary: "Additional lesson" }]
              : []),
          ].slice(0, args[2]),
        };
      if (fileBehavior === "throw") throw new Error("file lookup unavailable");
      return {
        success: fileBehavior !== "failure",
        memories:
          fileBehavior === "none"
            ? []
            : [
                {
                  id: "file-gotcha",
                  summary: "The auth helper needs a cookie before checking permissions.",
                  createdAt: "2026-11-01T00:00:00.000Z",
                  projectName: "fixture",
                },
              ],
      };
    },
  },
}));
mock.module(moduleUrl("services/tags"), () => ({
  getTags: () => ({ project: { tag: projectTag }, user: { userEmail: "fixture@example.test" } }),
}));
mock.module(moduleUrl("services/user-profile/profile-context"), () => ({
  getUserProfileContext: async (...args) => {
    profileCalls.push(args);
    return `profile revision ${profileCalls.length}`;
  },
}));
mock.module(moduleUrl("services/logger"), () => ({
  log() {},
  safeLog() {},
  serializeError: (error) => ({ error: String(error) }),
}));
mock.module(moduleUrl("services/web-server"), () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(moduleUrl("services/auto-update"), () => ({ startAutoUpdate() {} }));
globalThis.fetch = () => {
  throw new Error("Network is not allowed in this fixture");
};

// Keep real prompt persistence, shared plugin, path validation, recall and
// formatting. Only memory storage/provider/host boundaries are replaced.
const { OpenCodeMemPlugin } = await import(moduleUrl("index"));
const { userPromptManager } = await import(moduleUrl("services/user-prompt/user-prompt-manager"));
const { tursoConnectionManager } = await import(moduleUrl("services/turso/connection-manager"));
const pendingCalls = [];
const getPending = userPromptManager.getPendingPromptForMessage.bind(userPromptManager);
userPromptManager.getPendingPromptForMessage = async (...args) => {
  pendingCalls.push(args);
  return getPending(...args);
};
const client = {
  provider: { list: async () => ({ data: { connected: [] } }) },
  session: {
    messages: async () => ({ data: [] }),
    get: async ({ path }) => ({
      data: {
        title: path.id === "internal" ? "opencode-mem capture" : "ordinary task",
        ...(path.id === "child" ? { parentID: "parent" } : {}),
      },
    }),
  },
};
const pluginInput = { directory, client, fileObservationEnvironment: "local" };
const plugin = await OpenCodeMemPlugin(pluginInput);
const bridge = plugin.memoryContext;
let clock = Date.UTC(2026, 10, 5);
Date.now = () => ++clock;
for (const [id, text] of [
  ["active-a", "Active request A"],
  ["queued-b", "Queued request B"],
]) {
  const accepted = await bridge.capturePrompt(
    { sessionID: "regular" },
    {
      message: { id },
      parts: [{ type: "text", text }],
    }
  );
  if (!accepted) throw new Error("Fixture authored prompt was rejected");
}
await userPromptManager.savePrompt(
  "regular",
  "private",
  directory,
  "<private>private-request</private>"
);
await userPromptManager.savePrompt(
  "regular",
  "wrong-directory",
  join(fixtureDirectory, "elsewhere"),
  "Different directory request"
);
// Keep B newest, so an accidental latest-prompt lookup is observable.
await userPromptManager.savePrompt("regular", "queued-b-latest", directory, "Queued request B");
await userPromptManager.savePrompt(
  "another-session",
  "only-other-session",
  directory,
  "Different session request"
);
await userPromptManager.savePrompt("internal", "internal-input", directory, "Internal request");
await userPromptManager.savePrompt("child", "child-input", directory, "Delegated request");
const result = {};
const baseContext =
  "cached ordinary context\r\n<user_profile>original profile bytes</user_profile>\n";
async function load(name, sessionID = "regular", paths = [filePath], messageID = "active-a") {
  const starts = {
    search: searchCalls.length,
    file: fileCalls.length,
    list: listCalls.length,
    pending: pendingCalls.length,
    profile: profileCalls.length,
  };
  const text =
    paths === null
      ? await bridge.load(sessionID)
      : await bridge.loadFileContext(sessionID, paths, messageID, baseContext);
  result[name] = {
    text,
    search: searchCalls.slice(starts.search),
    file: fileCalls.slice(starts.file),
    list: listCalls.slice(starts.list),
    pending: pendingCalls.slice(starts.pending),
    profile: profileCalls.slice(starts.profile),
  };
}
await load("active");
await load("ordinary", "regular", null);
fileBehavior = "overlapNovel";
await load("overlapThenNovel");
fileBehavior = "overlap";
await load("overlapOnly");
for (const [name, behavior] of [
  ["noFileMatch", "none"],
  ["fileFailure", "failure"],
  ["fileThrows", "throw"],
]) {
  fileBehavior = behavior;
  await load(name);
}
config.chatMessage.recall = "recent";
fileBehavior = "none";
await load("recentNoFileMatch");
config.chatMessage.recall = "relevant";
fileBehavior = "match";
await load("emptyPaths", "regular", []);
await load("private", "regular", [filePath], "private");
await load("missing", "regular", [filePath], "missing");
await load("wrongDirectory", "regular", [filePath], "wrong-directory");
await load("wrongSession", "regular", [filePath], "only-other-session");
await load("outside", "regular", [outsidePath]);
pluginInput.fileObservationEnvironment = "workspace";
await load("workspace");
pluginInput.fileObservationEnvironment = "local";
config.chatMessage.fileAwareRecall = false;
await load("flagDisabled");
config.chatMessage.fileAwareRecall = true;
config.memoryBackend = "markdown";
config.markdownPath = join(fixtureDirectory, "vault");
await load("markdown");
config.memoryBackend = "database";
await load("internal", "internal", [filePath], "internal-input");
await load("child", "child", [filePath], "child-input");
config.chatMessage.enabled = false;
await load("injectionDisabled");
config.chatMessage.enabled = true;
configured = false;
await load("unconfigured");
configured = true;
config.chatMessage.maxMemories = 0;
await load("zeroCount");
await plugin.dispose();
await tursoConnectionManager.closeAll();
console.log(JSON.stringify({ result, directory, projectTag, baseContext }));
