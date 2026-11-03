import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = (path: string) => JSON.stringify(new URL(`../src/${path}`, import.meta.url).href);
// Fabricated fixtures, never usable credentials or data from a user's installation.
const secret = `ghp_${"a1B2".repeat(9)}`;

function scenario(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "credential-boundaries-"));
  try {
    const path = join(dir, "scenario.mjs");
    writeFileSync(
      path,
      `import { mock } from "bun:test";\nconst secret = ${JSON.stringify(secret)};\n${body}`
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, path],
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString());
    return JSON.parse(Buffer.from(result.stdout).toString().trim().split("\n").at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("credential redaction at actual plugin boundaries", () => {
  it("sanitizes pending prompts and durable evidence before database writes and truncation", () => {
    const result = scenario(`
const { CONFIG } = await import(${url("config.js")});
CONFIG.storagePath = process.env.HOME;
const { UserPromptManager } = await import(${url("services/user-prompt/user-prompt-manager.js")});
const { tursoConnectionManager } = await import(${url("services/turso/connection-manager.js")});
const manager = new UserPromptManager();
const id = await manager.savePrompt("s", "m", "/project", "Fix auth.ts using " + secret);
await manager.saveCaptureEvidence(id, "/project", "tool", "Test succeeded " + secret);
await manager.saveCaptureEvidence(id, "/project", "bounded", "x".repeat(16370) + " " + secret);
await manager.markCaptureEvidenceReady("s", "/project");
const db = await tursoConnectionManager.getConnection(process.env.HOME + "/user-prompts.db");
const prompt = await db.get("SELECT content FROM user_prompts WHERE id = ?", [id]);
const evidence = await db.all("SELECT content FROM pending_capture_evidence WHERE prompt_id = ?", [id]);
const replay = await manager.getCaptureEvidence(id, "/project");
console.log(JSON.stringify({ prompt: prompt.content, evidence, replay }));
await tursoConnectionManager.closeConnection(process.env.HOME + "/user-prompts.db");
`);
    expect(JSON.stringify(result)).not.toContain(secret);
    // A token straddling the persistence cap must not leave a recognizable prefix.
    expect(JSON.stringify(result)).not.toContain("ghp_");
    expect(result.prompt).toContain("Fix auth.ts using");
    expect(result.replay).toContain("Test succeeded");
  });

  for (const markdown of [false, true]) {
    it(`sanitizes explicit additions before embedding and ${markdown ? "Markdown plus index" : "Turso"} persistence`, () => {
      const result = scenario(`
const embeddings = [], records = [], files = [];
mock.module(${url("services/embedding.js")}, () => ({ embeddingService: {
  embedWithTimeout: async (text) => { embeddings.push(text); return new Float32Array([1,2,3]); }
} }));
mock.module(${url("services/turso/ready.js")}, () => ({ ensureTursoReady: async () => {} }));
mock.module(${url("services/turso/shard-manager.js")}, () => ({ tursoShardManager: {
  withScopeWriteLock: async (_s, _h, fn) => fn(),
  getWriteShard: async () => ({ id: 1, dbPath: "memory" }),
  getAllShards: async () => [{ id: 1, dbPath: "memory" }],
  incrementVectorCount: async () => {}
} }));
mock.module(${url("services/turso/connection-manager.js")}, () => ({ tursoConnectionManager: {
  getConnection: async () => ({})
} }));
mock.module(${url("services/turso/vector-search.js")}, () => ({ tursoVectorSearch: {
  insertVector: async (_db, record) => { records.push(record); },
  getMemoryById: async (_db, id) => records.find(r => r.id === id),
  listMemories: async () => records,
  searchAcrossShards: async () => ({ results: records.map(r => ({ id: r.id, content: r.content, similarity: 0.9 })), warnings: [] })
} }));
mock.module(${url("services/markdown/backend.js")}, () => ({
  isMarkdownBackend: () => ${markdown},
  writeMemoryMarkdownFile: (record) => { files.push(record); }
}));
const { LocalMemoryClient } = await import(${url("services/client.js")});
const client = new LocalMemoryClient();
const result = await client.addMemory("Configured auth.ts with " + secret,
  "opencode_project_abcdef1234567890", { source: "manual", tags: ["auth", secret] });
const readback = await client.getMemoryById(result.id);
const listing = await client.listMemories("opencode_project_abcdef1234567890");
const search = await client.searchMemories("auth setup", "opencode_project_abcdef1234567890");
console.log(JSON.stringify({ result, embeddings, records, files, readback, listing, search }));
`);
      expect(result.result.success).toBe(true);
      expect(result.embeddings.length).toBe(3);
      expect(result.readback.memory.content).toBe(result.records[0].content);
      expect(result.listing.memories[0].summary).toBe(result.records[0].content);
      expect(result.search.results[0].content).toBe(result.records[0].content);
      expect(result.records.length).toBe(1);
      expect(result.files.length).toBe(markdown ? 1 : 0);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.records[0].content).toContain("Configured auth.ts with");
      expect(result.records[0].tags).toContain("auth");
    });
  }

  for (const order of ["opencode-first", "external-first"] as const) {
    it(`protects live context and generated output across ${order} fallback`, () => {
      const result = scenario(`
const requests = [], writes = [], logs = [];
mock.module(${url("config.js")}, () => ({ CONFIG: {
  autoCaptureMaxRetries: 1, autoCaptureProviderStatus: { ready: true }, autoCaptureLanguage: "en",
  autoCaptureProviderOrder: ${JSON.stringify(order)}, opencodeProvider: "openai", opencodeModel: "test",
  memoryProvider: "openai-chat", memoryModel: "test", memoryApiUrl: "https://example.invalid/v1",
  showAutoCaptureToasts: false, showErrorToasts: false
} }));
mock.module(${url("services/client.js")}, () => ({ memoryClient: {
  listMemories: async () => ({ success: true, memories: [{ summary: "Previous auth setup " + "x".repeat(470) + " " + secret }] }),
  addMemory: async (content, tag, metadata) => { writes.push({content, metadata}); return {success: true, id: "mem"}; },
  close() {}
} }));
mock.module(${url("services/tags.js")}, () => ({ getTags: () => ({ project: { tag: "opencode_project_test", projectPath: "/project" } }) }));
const prompt = { id: "p", sessionId: "s", messageId: "m", projectPath: "/project",
  content: "Fix auth.ts " + secret, providerId: "openai", modelId: "test", capture_attempts: 0 };
mock.module(${url("services/user-prompt/user-prompt-manager.js")}, () => ({ userPromptManager: {
  getCaptureEvidence: async () => null, getUncapturedPromptsForSession: async () => [prompt],
  claimPrompt: async () => true, releaseClaim() {}, deletePrompt() {}, markAsCaptured() {},
  linkMemoryToPrompt() {}, recordFailedAttempt() {}
} }));
mock.module(${url("services/logger.js")}, () => ({
  log: (message, data) => logs.push({message, data}), safeLog: () => {},
  serializeError: (error) => ({error: String(error), name: "Error"})
}));
mock.module(${url("services/language-detector.js")}, () => ({ detectLanguage: () => "en", getLanguageName: () => "English" }));
const output = () => ({ summary: "Fixed auth.ts " + secret, type: "bug-fix", tags: ["auth", secret] });
mock.module(${url("services/ai/opencode-provider-loader.js")}, () => ({ loadOpencodeProvider: async () => ({
  ensureProviderConnected: async () => true, getV2Client: () => ({}),
  generateStructuredOutput: async (request) => {
    requests.push({ channel: "opencode", text: request.userPrompt });
    if (${JSON.stringify(order)} === "opencode-first") throw new Error("synthetic unavailable");
    return output();
  }
}) }));
mock.module(${url("services/ai/provider-config.js")}, () => ({ buildMemoryProviderConfig: () => ({}) }));
mock.module(${url("services/ai/ai-provider-factory.js")}, () => ({ AIProviderFactory: {
  createProvider: () => ({ executeToolCall: async (_system, text) => {
    requests.push({channel: "external", text});
    return ${JSON.stringify(order)} === "external-first" ? { success: false, error: "synthetic unavailable" } : { success: true, data: output() };
  } }), cleanupExpiredSessions: async () => 0
} }));
const { performAutoCapture } = await import(${url("services/auto-capture.js")});
await performAutoCapture({ client: { session: { messages: async () => ({data: [
  {info: {id: "m", role: "user"}, parts: [{type: "text", text: prompt.content}]},
  {info: {id: "a", role: "assistant"}, parts: [
    {type: "text", text: "Auth tests passed " + secret},
    {type: "tool", tool: "bash", state: {input: {command: "validate " + "x".repeat(70) + " " + secret}}},
    {type: "tool", tool: "bash", state: {input: {command: 'export API_KEY="abc123456789"', password: "abc123456789"}}}
  ]}
]}) }, tui: {showToast: async () => ({})} } }, "s", "/project");
console.log(JSON.stringify({ requests, writes, logs }));
`);
      expect(result.requests.map((r: { channel: string }) => r.channel)).toEqual(
        order === "opencode-first" ? ["opencode", "external"] : ["external", "opencode"]
      );
      expect(result.writes.length).toBe(1);
      expect(JSON.stringify(result)).not.toContain(secret);
      // Provider output normalizes tags to lowercase; it must not bypass redaction.
      expect(JSON.stringify(result)).not.toContain(secret.toLowerCase());
      expect(JSON.stringify(result)).not.toContain("ghp_");
      expect(JSON.stringify(result)).not.toContain("abc123456789");
      for (const request of result.requests) {
        expect(request.text).toContain("Auth tests passed");
        expect(request.text).toContain("Previous auth setup");
        expect(request.text).toContain("validate");
      }
    });
  }
  it("redacts serialized error fields and nested log strings without mutating caller data", () => {
    const result = scenario(`
import { readFileSync } from "node:fs";
process.env.OPENCODE_MEM_LOG_FILE = process.env.HOME + "/diagnostics.log";
const { log, serializeError } = await import(${url("services/logger.js")});
const error = new Error("Provider rejected " + secret, {cause: new Error("Request contained " + secret)});
const data = { code: "E_SYNTHETIC", password: "abc123456789", [secret]: "context", nested: {api_key: "def123456789", details: "Failed auth.ts " + secret, command: 'API_KEY="abc123456789"'}, error: serializeError(error) };
log("Capture failed " + secret, data);
const text = readFileSync(process.env.OPENCODE_MEM_LOG_FILE, "utf8");
console.log(JSON.stringify({text, serialized: data.error, unchanged: data.nested.details.endsWith(secret) && error.message.endsWith(secret)}));
`);
    expect(result.unchanged).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.text).not.toContain("abc123456789");
    expect(result.text).not.toContain("def123456789");
    expect(result.text).toContain("E_SYNTHETIC");
    expect(result.text).toContain("Failed auth.ts");
    expect(result.serialized.error).toContain("Provider rejected");
    expect(result.serialized.cause).toContain("Request contained");
    expect(result.serialized.stack).toContain("Error:");
  });

  for (const v1 of [false, true]) {
    it(`redacts final ${v1 ? "V1" : "V2"} assistant/tool observations before durable recovery`, () => {
      const result = scenario(`
const { CONFIG } = await import(${url("config.js")});
CONFIG.storagePath = process.env.HOME;
const { userPromptManager } = await import(${url("services/user-prompt/user-prompt-manager.js")});
userPromptManager.reset();
const { CaptureEvidenceRecorder } = await import(${url("services/capture-evidence.js")});
const { tursoConnectionManager } = await import(${url("services/turso/connection-manager.js")});
const id = await userPromptManager.savePrompt("s", "m", "/project", "Fix auth.ts");
const recorder = new CaptureEvidenceRecorder("/project");
const toolName = "tool " + "x".repeat(110) + " " + secret;
const event = (type, properties) => recorder.observe({type, properties});
if (${v1}) {
  await event("message.updated", {info: {id: "a", sessionID: "s", role: "assistant", parentID: "m"}});
  await event("message.part.updated", {part: {id: "text", sessionID: "s", messageID: "a", type: "text", time: {end: 1}, text: "Auth tests passed " + secret}});
  await event("message.part.updated", {part: {id: "tool", sessionID: "s", messageID: "a", type: "tool", tool: toolName, state: {status: "completed", output: "3 checks passed " + secret}}});
} else {
  await event("session.inbox.delivered", {sessionID: "s", inboxID: "m"});
  await event("session.step.started", {sessionID: "s", assistantMessageID: "a"});
  await event("session.text.ended", {sessionID: "s", assistantMessageID: "a", ordinal: 0, text: "Auth tests passed " + secret});
  await event("session.tool.input.started", {sessionID: "s", assistantMessageID: "a", id: "tool", name: toolName});
  await event("session.tool.success", {sessionID: "s", assistantMessageID: "a", id: "tool", content: [{type: "text", text: "3 checks passed " + secret}]});
}
await event("session.deleted", {sessionID: "s"});
const evidence = await userPromptManager.getCaptureEvidence(id, "/project");
console.log(JSON.stringify({evidence}));
await recorder.drain();
await tursoConnectionManager.closeConnection(process.env.HOME + "/user-prompts.db");
`);
      expect(result.evidence).toContain("Auth tests passed");
      expect(result.evidence).toContain("3 checks passed");
      expect(result.evidence).not.toContain(secret);
      expect(result.evidence).not.toContain("ghp_");
    });
  }
  it("redacts case-sensitive credential tags before the actual memory tool normalizes them", () => {
    const result = scenario(`
const calls = [];
const googleKey = "AIza" + "a1B2".repeat(8) + "a1B";
mock.module(${url("services/client.js")}, () => ({memoryClient: {
  warmup: async () => {}, ensureStorageReady: async () => {}, getEmbeddingInitError: () => null,
  addMemory: async (content, _tag, metadata) => {calls.push({content, metadata}); return {success: true, id: "memory"};}, close() {}
}}));
mock.module(${url("config.js")}, () => ({CONFIG: {autoCaptureLanguage: "en", memory: {defaultScope: "project"}}, initConfig() {}, isConfigured: () => true}));
mock.module(${url("services/tags.js")}, () => ({getTags: () => ({project: {tag: "project-tag"}, user: {userEmail: "synthetic@example.invalid"}})}));
mock.module(${url("services/context.js")}, () => ({formatContextForPrompt: () => ""}));
mock.module(${url("services/auto-capture.js")}, () => ({performAutoCapture: async () => {}, awaitCaptureDrain: async () => {}}));
mock.module(${url("services/user-memory-learning.js")}, () => ({performUserProfileLearning: async () => {}}));
mock.module(${url("services/user-prompt/user-prompt-manager.js")}, () => ({userPromptManager: {savePrompt() {}}}));
mock.module(${url("services/web-server.js")}, () => ({startWebServer: async () => null, WebServer: class {}}));
mock.module(${url("services/logger.js")}, () => ({log() {}, safeLog() {}, serializeError: (error) => ({error: String(error)})}));
mock.module(${url("services/language-detector.js")}, () => ({getLanguageName: () => "English"}));
const { OpenCodeMemPlugin } = await import(${url("index.js")});
const plugin = await OpenCodeMemPlugin({directory: "/project", client: {}});
const result = JSON.parse(await plugin.tool.memory.execute({mode: "add", content: "Configured auth.ts", tags: "Auth," + googleKey}, {sessionID: "s"}));
console.log(JSON.stringify({result, calls, leaked: JSON.stringify({result,calls}).toLowerCase().includes(googleKey.toLowerCase())}));
`);
    expect(result.result.success).toBe(true);
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].metadata.tags[0]).toBe("auth");
    expect(result.leaked).toBe(false);
  });

  it("redacts update-decision snippets before truncation without changing historical candidates", () => {
    const result = scenario(`
const { buildUpdateOnCaptureDecisionPrompt } = await import(${url("services/update-on-capture.js")});
const candidate = {id: "old", similarity: 0.9, content: "Previous auth setup " + "x".repeat(770) + " " + secret};
const prompt = buildUpdateOnCaptureDecisionPrompt("New auth configuration " + secret, [candidate]);
console.log(JSON.stringify({prompt, unchanged: candidate.content.endsWith(secret)}));
`);
    expect(result.unchanged).toBe(true);
    expect(result.prompt).toContain("Previous auth setup");
    expect(result.prompt).toContain("New auth configuration");
    expect(result.prompt).not.toContain("ghp_");
  });

  for (const provided of [false, true]) {
    it(`${provided ? "sanitizes supplied" : "does not rewrite historical"} content/tags in shared updates`, () => {
      const result = scenario(`
const embeddings = [], writes = [], files = [];
const existing = {id: "old", content: "Historical auth setup " + secret, tags: secret,
  container_tag: "opencode_project_abcdef1234567890", created_at: 1, metadata: "{}"};
mock.module(${url("services/embedding.js")}, () => ({embeddingService: {
  warmup: async () => {}, embedWithTimeout: async (text) => {embeddings.push(text); return new Float32Array([1,2,3]);}
}}));
mock.module(${url("services/turso/ready.js")}, () => ({ensureTursoReady: async () => {}}));
mock.module(${url("services/turso/shard-manager.js")}, () => ({tursoShardManager: {getAllShards: async () => [{dbPath: "memory"}]}}));
mock.module(${url("services/turso/connection-manager.js")}, () => ({tursoConnectionManager: {
  getConnection: async () => ({transaction: async (_mode, fn) => fn({execute: async (statement) => {writes.push(statement);}})})
}}));
mock.module(${url("services/turso/vector-search.js")}, () => ({tursoVectorSearch: {getMemoryById: async () => existing}}));
mock.module(${url("services/markdown/backend.js")}, () => ({isMarkdownBackend: () => true, writeMemoryMarkdownFile: (memory) => files.push(memory)}));
const { LocalMemoryClient } = await import(${url("services/client.js")});
const data = ${provided} ? {content: "Corrected auth.ts " + secret, tags: ["auth", secret]} : {type: "configuration"};
const result = await new LocalMemoryClient().updateMemory("old", data);
console.log(JSON.stringify({result, embeddings, writes, files, unchanged: existing.content.endsWith(secret)}));
`);
      expect(result.result.success).toBe(true);
      expect(result.unchanged).toBe(true);
      expect(result.writes.length).toBe(2);
      if (provided) {
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(result.files[0].content).toContain("Corrected auth.ts");
      } else {
        expect(result.files[0].content).toBe("Historical auth setup " + secret);
        expect(result.files[0].tags).toEqual([secret]);
      }
    });
  }
});
