import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../src/config.js";
import { UserPromptManager } from "../src/services/user-prompt/user-prompt-manager.js";
import { AISessionManager } from "../src/services/ai/session/ai-session-manager.js";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";

const directory = mkdtempSync(join(tmpdir(), "capture-storage-growth-"));
const previousStorage = CONFIG.storagePath;
const paths = [join(directory, "user-prompts.db"), join(directory, "ai-sessions.db")];
const bytes = (path: string) =>
  [path, `${path}-wal`, `${path}-shm`, `${path}-tshm`].reduce(
    (sum, file) => sum + (existsSync(file) ? statSync(file).size : 0),
    0
  );

afterAll(async () => {
  for (const path of paths) await tursoConnectionManager.closeConnection(path);
  CONFIG.storagePath = previousStorage;
  rmSync(directory, { recursive: true, force: true });
});

it("bounds repeated multi-megabyte recovery evidence including database sidecars", async () => {
  CONFIG.storagePath = directory;
  const manager = new UserPromptManager();
  const id = await manager.savePrompt("session", "message", "/synthetic", "Test build");
  const output = "synthetic log line\n".repeat(120000);
  await manager.saveCaptureEvidence(id, "/synthetic", "tool", output);
  const firstSize = bytes(paths[0]!);
  for (let i = 0; i < 30; i++) await manager.saveCaptureEvidence(id, "/synthetic", "tool", output);
  const db = await tursoConnectionManager.getConnection(paths[0]!);
  const row = await db.get(
    "SELECT COUNT(*) n, SUM(length(CAST(content AS BLOB))) payload FROM pending_capture_evidence"
  );
  expect(Number(row!.n)).toBe(1);
  expect(Number(row!.payload)).toBeLessThanOrEqual(16384);
  // Physical files need not shrink after DELETE. Assert bounded growth rather
  // than promising that retained payload bytes equal SQLite's file size.
  expect(bytes(paths[0]!) - firstSize).toBeLessThan(2 * 1024 * 1024);
  await manager.markAsCaptured(id);
  expect(Number((await db.get("SELECT COUNT(*) n FROM pending_capture_evidence"))!.n)).toBe(0);
}, 30000);

it("expires provider history and cascades message cleanup without promising file shrinkage", async () => {
  CONFIG.storagePath = directory;
  const sessions = new AISessionManager();
  const { extractAIContent, buildMarkdownContext } =
    await import("../src/services/auto-capture.js");
  const hugeOutput = "synthetic output\n".repeat(150000);
  const extracted = extractAIContent([
    {
      info: { role: "assistant" },
      parts: Array.from({ length: 100 }, (_, i) => ({
        type: "tool",
        id: `call-${i}`,
        tool: "bash",
        state: { status: "completed", input: { command: "test" }, output: hugeOutput },
      })),
    },
  ]);
  const request = buildMarkdownContext("Run tests", [], extracted.toolCalls, null);
  expect(Buffer.byteLength(request)).toBeLessThan(20 * 1024);
  const initialSize = bytes(paths[1]!);
  for (let i = 0; i < 30; i++) {
    const session = await sessions.createSession({
      provider: "openai-chat",
      sessionId: `retry-${i}`,
    });
    await sessions.addMessage({
      aiSessionId: session.id,
      sequence: 0,
      role: "user",
      content: request,
    });
    await sessions.addMessage({
      aiSessionId: session.id,
      sequence: 1,
      role: "assistant",
      content: "A small outcome summary",
    });
  }
  const db = await tursoConnectionManager.getConnection(paths[1]!);
  expect(Number((await db.get("SELECT COUNT(*) n FROM ai_messages"))!.n)).toBe(60);
  // This intentionally shows that distinct attempts do retain separate copies.
  expect(bytes(paths[1]!) - initialSize).toBeLessThan(8 * 1024 * 1024);
  await db.run("UPDATE ai_sessions SET expires_at = 1");
  expect(await sessions.cleanupExpiredSessions()).toBe(30);
  expect(Number((await db.get("SELECT COUNT(*) n FROM ai_messages"))!.n)).toBe(0);
}, 30000);
