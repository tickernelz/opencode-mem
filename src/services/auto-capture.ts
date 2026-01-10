import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";

interface MessageEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface ToolEntry {
  name: string;
  args: unknown;
  result: string;
  timestamp: number;
}

interface CaptureBuffer {
  sessionID: string;
  iterationCount: number;
  messages: MessageEntry[];
  tools: ToolEntry[];
  lastCaptureTime: number;
  fileEdits: number;
}

export class AutoCaptureService {
  private buffers = new Map<string, CaptureBuffer>();
  private capturing = new Set<string>();
  private threshold: number;
  private timeThreshold: number;
  private enabled: boolean;

  constructor() {
    this.threshold = CONFIG.autoCaptureThreshold;
    this.timeThreshold = CONFIG.autoCaptureTimeThreshold * 60 * 1000;
    this.enabled = CONFIG.autoCaptureEnabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  private getOrCreateBuffer(sessionID: string): CaptureBuffer {
    if (!this.buffers.has(sessionID)) {
      this.buffers.set(sessionID, {
        sessionID,
        iterationCount: 0,
        messages: [],
        tools: [],
        lastCaptureTime: Date.now(),
        fileEdits: 0,
      });
    }
    return this.buffers.get(sessionID)!;
  }

  onSessionIdle(sessionID: string): boolean {
    if (!this.enabled) return false;
    if (this.capturing.has(sessionID)) return false;

    const buffer = this.getOrCreateBuffer(sessionID);
    buffer.iterationCount++;

    const timeSinceCapture = Date.now() - buffer.lastCaptureTime;
    const iterationMet = buffer.iterationCount >= this.threshold;
    const timeMet = this.timeThreshold > 0 && timeSinceCapture >= this.timeThreshold;

    return iterationMet || timeMet;
  }

  addMessage(sessionID: string, role: "user" | "assistant", content: string) {
    if (!this.enabled) return;
    const buffer = this.getOrCreateBuffer(sessionID);
    buffer.messages.push({ role, content, timestamp: Date.now() });
  }

  addTool(sessionID: string, name: string, args: unknown, result: string) {
    if (!this.enabled) return;
    const buffer = this.getOrCreateBuffer(sessionID);
    buffer.tools.push({ name, args, result, timestamp: Date.now() });
  }

  onFileEdit(sessionID: string) {
    if (!this.enabled) return;
    const buffer = this.getOrCreateBuffer(sessionID);
    buffer.fileEdits++;
  }

  getSummaryPrompt(sessionID: string): string {
    const buffer = this.buffers.get(sessionID);
    if (!buffer) return "";

    const conversationText = buffer.messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const toolsText = buffer.tools.length > 0
      ? `\n\nTools executed:\n${buffer.tools.map((t) => `- ${t.name}`).join("\n")}`
      : "";

    return `Summarize the following ${buffer.iterationCount} iterations of development conversation.

Focus on:
- Key decisions and solutions implemented
- Problems encountered and how they were resolved
- Important patterns or approaches learned
- Critical context needed for future work

${conversationText}${toolsText}

Provide a concise, actionable summary (max 250 words).`;
  }

  markCapturing(sessionID: string) {
    this.capturing.add(sessionID);
  }

  clearBuffer(sessionID: string) {
    const buffer = this.buffers.get(sessionID);
    if (buffer) {
      this.buffers.set(sessionID, {
        sessionID,
        iterationCount: 0,
        messages: [],
        tools: [],
        lastCaptureTime: Date.now(),
        fileEdits: 0,
      });
    }
    this.capturing.delete(sessionID);
  }

  getStats(sessionID: string) {
    const buffer = this.buffers.get(sessionID);
    if (!buffer) return null;

    return {
      iterations: buffer.iterationCount,
      messages: buffer.messages.length,
      tools: buffer.tools.length,
      fileEdits: buffer.fileEdits,
      timeSinceCapture: Date.now() - buffer.lastCaptureTime,
    };
  }

  cleanup(sessionID: string) {
    this.buffers.delete(sessionID);
    this.capturing.delete(sessionID);
  }
}

export async function performAutoCapture(
  ctx: PluginInput,
  service: AutoCaptureService,
  sessionID: string,
  directory: string
): Promise<void> {
  try {
    service.markCapturing(sessionID);

    await ctx.client?.tui.showToast({
      body: {
        title: "Auto-Capture",
        message: "Summarizing conversation...",
        variant: "info",
        duration: 2000,
      },
    }).catch(() => {});

    const prompt = service.getSummaryPrompt(sessionID);
    if (!prompt) {
      log("Auto-capture: no content to summarize", { sessionID });
      service.clearBuffer(sessionID);
      return;
    }

    const summary = await summarizeWithAI(ctx, sessionID, prompt);
    if (!summary) {
      throw new Error("Failed to generate summary");
    }

    const tags = getTags(directory);
    const scope = CONFIG.autoCaptureScope;
    const containerTag = scope === "user" ? tags.user : tags.project;

    const stats = service.getStats(sessionID);
    const result = await memoryClient.addMemory(summary, containerTag, {
      type: "conversation",
      source: "auto-capture",
      sessionID,
      iterations: stats?.iterations,
      messageCount: stats?.messages,
      toolCount: stats?.tools,
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to save memory");
    }

    await ctx.client?.tui.showToast({
      body: {
        title: "Memory Captured",
        message: `Saved summary (${stats?.iterations} iterations)`,
        variant: "success",
        duration: 3000,
      },
    }).catch(() => {});

    log("Auto-capture: success", {
      sessionID,
      memoryID: result.id,
      iterations: stats?.iterations,
      scope,
    });

    service.clearBuffer(sessionID);
  } catch (error) {
    log("Auto-capture: error", { sessionID, error: String(error) });

    await ctx.client?.tui.showToast({
      body: {
        title: "Auto-Capture Failed",
        message: String(error),
        variant: "error",
        duration: 5000,
      },
    }).catch(() => {});

    service.clearBuffer(sessionID);
  }
}

async function summarizeWithAI(
  ctx: PluginInput,
  sessionID: string,
  prompt: string
): Promise<string> {
  if (!ctx.client) {
    throw new Error("Client not available");
  }

  const response = await ctx.client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: false,
      parts: [{ type: "text", text: prompt }],
    },
  });

  if (!response.data) {
    throw new Error("No response from AI");
  }

  const textParts = response.data.parts.filter(
    (p: any) => p.type === "text"
  );

  return textParts.map((p: any) => p.text).join("").trim();
}
