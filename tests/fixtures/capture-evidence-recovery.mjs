import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const u = (path) => new URL("../../src/" + path + ".js", import.meta.url).href;
const scenario = JSON.parse(process.argv[2] ?? "{}");
const dir = mkdtempSync(join(tmpdir(), "capture-evidence-recovery-"));
const project = join(dir, "project");
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.HOME = dir;
process.env.USERPROFILE = dir;
const { cleanupTursoTestDirectory } = await import("../turso-test-utils.js");
const { CONFIG } = await import(u("config"));
Object.assign(CONFIG, {
  storagePath: dir,
  autoCaptureMaxRetries: 3,
  autoCaptureProviderStatus: { ready: true, mode: "opencode", issues: [] },
  autoCaptureLanguage: "en",
  opencodeProvider: "openai",
  opencodeModel: "test-model",
  showAutoCaptureToasts: false,
  showErrorToasts: false,
  updateOnCaptureEnabled: false,
});
const counters = { fetch: 0, summary: 0, persist: 0 };
const logs = [],
  summaryInputs = [];
const logger = { ...(await import(u("services/logger"))) };
mock.module(u("services/logger"), () => ({
  ...logger,
  log: (message, data) => logs.push({ message, ...data }),
  safeLog: () => {},
}));
mock.module(u("services/language-detector"), () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(u("services/tags"), () => ({
  getTags: () => ({ project: { tag: "synthetic-project" } }),
}));
mock.module(u("services/client"), () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async () => {
      counters.persist++;
      return { success: true, id: `memory-${counters.persist}` };
    },
  },
}));
mock.module(u("services/ai/opencode-provider-loader"), () => ({
  loadOpencodeProvider: async () => ({
    ensureProviderConnected: async () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async (input) => {
      counters.summary++;
      summaryInputs.push(input.userPrompt);
      return { type: "discussion", summary: "Observed synthetic tested fix", tags: [] };
    },
  }),
}));
const { userPromptManager: mgr, UserPromptManager } = await import(
  u("services/user-prompt/user-prompt-manager")
);
const { tursoConnectionManager } = await import(u("services/turso/connection-manager"));
const { CaptureEvidenceRecorder } = await import(u("services/capture-evidence"));
const { performAutoCapture } = await import(u("services/auto-capture"));
const ctx = {
  client: {
    session: {
      messages: async () => {
        counters.fetch++;
        if (scenario.liveHost) {
          return {
            data: [
              {
                info: { id: "u", role: "user" },
                parts: [{ type: "text", text: "Fix synthetic regression" }],
              },
              {
                info: { id: "a", role: "assistant" },
                parts: [
                  { type: "text", text: "Live host transcript with full tool inputs" },
                  {
                    type: "tool",
                    tool: "test",
                    state: { status: "completed", input: { file: "live.ts" }, output: "ok" },
                  },
                ],
              },
            ],
          };
        }
        throw Object.assign(new Error(""), { name: "Session.NotFoundError" });
      },
    },
  },
};
let recorder = new CaptureEvidenceRecorder(project);
const emit = (type, properties) => recorder.observe({ type, properties });
const olderId = scenario.olderPending
  ? await mgr.savePrompt("s", "older-user", project, "Earlier request with no preserved output")
  : null;
if (olderId) {
  const db = await tursoConnectionManager.getConnection(join(dir, "user-prompts.db"));
  await db.run("UPDATE user_prompts SET created_at = created_at - 1000 WHERE id = ?", [olderId]);
}
const id = await mgr.savePrompt(
  "s",
  "u",
  scenario.otherProject ? join(dir, "other") : project,
  "Fix synthetic regression"
);
let restoredSessions = [];
let queuedId = null;
try {
  if (!scenario.noEvidence) {
    if (scenario.v1) {
      await emit("message.updated", {
        info: { id: "a", sessionID: "s", role: "assistant", parentID: "u" },
      });
    } else {
      await emit("session.inbox.delivered", { sessionID: "s", inboxID: "u" });
      if (scenario.unknownInbox)
        await emit("session.inbox.delivered", { sessionID: "s", inboxID: "untracked-synthetic" });
      await emit("session.step.started", { sessionID: "s", assistantMessageID: "a" });
    }
    if (scenario.queuedNext)
      queuedId = await mgr.savePrompt(
        "s",
        "next-user",
        project,
        "Next synthetic request is queued"
      );
    const parts = scenario.privateParts
      ? ["Visible fix <private>SECRET_A", "SECRET_B</private> verified tests"]
      : ["Changed synthetic implementation and verified tests"];
    for (let i = 0; i < parts.length; i++) {
      const props = scenario.v1
        ? {
            part: {
              id: `text-${i}`,
              sessionID: "s",
              messageID: "a",
              type: "text",
              text: parts[i],
              time: { end: 1 },
            },
          }
        : { sessionID: "s", assistantMessageID: "a", ordinal: i, text: parts[i] };
      await emit(scenario.v1 ? "message.part.updated" : "session.text.ended", props);
      if (scenario.duplicate || scenario.olderPending)
        await emit(scenario.v1 ? "message.part.updated" : "session.text.ended", props);
    }
    if (scenario.v1)
      await emit("message.part.updated", {
        part: {
          id: "tool-1",
          sessionID: "s",
          messageID: "a",
          type: "tool",
          tool: "test",
          state: { status: "completed", output: "3 synthetic tests passed" },
        },
      });
    else {
      await emit("session.tool.input.started", {
        sessionID: "s",
        assistantMessageID: "a",
        id: "tool-1",
        name: "test",
      });
      await emit("session.tool.success", {
        sessionID: "s",
        assistantMessageID: "a",
        id: "tool-1",
        content: [{ type: "text", text: "3 synthetic tests passed" }],
      });
    }
  }
  await emit(scenario.deletedCheckpoint ? "session.deleted" : "session.idle", { sessionID: "s" });
  await recorder.drain();
  const evidence = await mgr.getCaptureEvidence(id, project);
  if (scenario.restart) {
    await tursoConnectionManager.closeAll();
    mgr.reset();
    const restored = new UserPromptManager();
    restoredSessions = await restored.getPendingCaptureSessions(project);
    recorder = new CaptureEvidenceRecorder(project);
  }
  // Prefer durable evidence for deleted-session recovery. The olderPending
  // starvation case and liveHost preference leave preferSavedEvidence off so
  // the live transcript path runs first.
  const captureOpts = {
    preferSavedEvidence: !scenario.olderPending && !scenario.liveHost,
  };
  await performAutoCapture(ctx, "s", project, captureOpts);
  if (scenario.duplicate) await performAutoCapture(ctx, "s", project, captureOpts);
  const prompt = await mgr.getPromptById(id);
  const olderPrompt = olderId ? await mgr.getPromptById(olderId) : null;
  const afterEvidence = await mgr.getCaptureEvidence(id, project);
  const queuedPrompt = queuedId ? await mgr.getPromptById(queuedId) : null;
  const queuedEvidence = queuedId ? await mgr.getCaptureEvidence(queuedId, project) : null;
  console.log(
    "EVIDENCE_RESULT=" +
      JSON.stringify({
        counters,
        evidence,
        afterEvidence,
        prompt,
        olderPrompt,
        queuedPrompt,
        queuedEvidence,
        restoredSessions,
        summaryInputs,
        logs,
      })
  );
} finally {
  await recorder.drain();
  await tursoConnectionManager.closeAll();
  await cleanupTursoTestDirectory(dir);
}
