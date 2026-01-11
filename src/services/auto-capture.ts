import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { MemoryType } from "../types/index.js";

interface CaptureBuffer {
  sessionID: string;
  lastCaptureTokens: number;
  lastCaptureTime: number;
  lastCapturedMessageIndex: number;
}

interface MemoryEntry {
  summary: string;
  scope: "user" | "project";
  type: MemoryType;
  reasoning?: string;
}

interface CaptureResponse {
  memories: MemoryEntry[];
}

interface ToolCallResponse {
  choices: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
}

export class AutoCaptureService {
  private buffers = new Map<string, CaptureBuffer>();
  private capturing = new Set<string>();
  private tokenThreshold: number;
  private minTokens: number;
  private enabled: boolean;
  private maxMemories: number;

  constructor() {
    this.tokenThreshold = CONFIG.autoCaptureTokenThreshold;
    this.minTokens = CONFIG.autoCaptureMinTokens;
    this.maxMemories = CONFIG.autoCaptureMaxMemories;

    this.enabled =
      CONFIG.autoCaptureEnabled &&
      !!CONFIG.memoryModel &&
      !!CONFIG.memoryApiUrl &&
      !!CONFIG.memoryApiKey;

    if (CONFIG.autoCaptureEnabled && !this.enabled) {
      log(
        "Auto-capture disabled: external API not configured (memoryModel, memoryApiUrl, memoryApiKey required)"
      );
    }

    if (this.enabled && CONFIG.memoryApiUrl?.includes("ollama")) {
      log("Warning: Ollama may not support tool calling. Auto-capture might fail.");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getDisabledReason(): string | null {
    if (!CONFIG.autoCaptureEnabled) return "Auto-capture disabled in config";
    if (!CONFIG.memoryModel) return "memoryModel not configured";
    if (!CONFIG.memoryApiUrl) return "memoryApiUrl not configured";
    if (!CONFIG.memoryApiKey) return "memoryApiKey not configured";
    return null;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  getOrCreateBuffer(sessionID: string): CaptureBuffer {
    if (!this.buffers.has(sessionID)) {
      this.buffers.set(sessionID, {
        sessionID,
        lastCaptureTokens: 0,
        lastCaptureTime: Date.now(),
        lastCapturedMessageIndex: -1,
      });
    }
    return this.buffers.get(sessionID)!;
  }

  checkTokenThreshold(sessionID: string, totalTokens: number): boolean {
    if (!this.enabled) return false;
    if (this.capturing.has(sessionID)) return false;

    const buffer = this.getOrCreateBuffer(sessionID);

    if (totalTokens < this.minTokens) return false;

    const tokensSinceCapture = totalTokens - buffer.lastCaptureTokens;

    if (tokensSinceCapture >= this.tokenThreshold) {
      buffer.lastCaptureTokens = totalTokens;
      return true;
    }

    return false;
  }

  getSystemPrompt(hasContext: boolean): string {
    const summaryGuidance =
      CONFIG.autoCaptureSummaryMaxLength > 0
        ? `Keep summaries under ${CONFIG.autoCaptureSummaryMaxLength} characters.`
        : "Extract key details and important information. Be concise but complete.";

    const contextNote = hasContext
      ? `\n\nIMPORTANT: Messages marked [CONTEXT] were already analyzed in previous capture. They are provided for context only. Focus your extraction on messages marked [NEW]. Do not duplicate memories from context messages.`
      : "";

    return `You are a memory extraction assistant analyzing PAST conversations between a USER and an AI ASSISTANT.

IMPORTANT CONTEXT:
- The conversation below has ALREADY HAPPENED
- You are NOT the assistant in this conversation
- Your job is to EXTRACT MEMORIES from this past conversation
- DO NOT try to continue or respond to the conversation
- DO NOT execute any tasks mentioned in the conversation${contextNote}

EXTRACTION GUIDELINES:

Categorize each memory by scope:
- "user": Cross-project user behaviors, preferences, patterns, requests
  Examples: "prefers TypeScript", "likes concise responses", "often asks about complexity analysis"
- "project": Project-specific knowledge, decisions, architecture, context
  Examples: "uses Bun runtime", "API at /api/v1", "working on opencode-mem plugin"

Memory categorization:
- Choose appropriate type: preference, architecture, workflow, bug-fix, configuration, pattern, request, context
- Be specific and descriptive with categories
- Focus on WHAT WAS DISCUSSED, not what should be done

Summary guidelines:
- ${summaryGuidance}
- Only extract memories worth long-term retention
- Be selective: quality over quantity
- Each memory should be atomic and independent
- Maximum ${this.maxMemories} memories per capture
- Extract facts, decisions, and context - NOT tasks or actions

Use the save_memories function to save extracteories.`;
  }

  markCapturing(sessionID: string) {
    this.capturing.add(sessionID);
  }

  clearBuffer(sessionID: string) {
    const buffer = this.buffers.get(sessionID);
    if (buffer) {
      this.buffers.set(sessionID, {
        sessionID,
        lastCaptureTokens: buffer.lastCaptureTokens,
        lastCaptureTime: Date.now(),
        lastCapturedMessageIndex: buffer.lastCapturedMessageIndex,
      });
    }
    this.capturing.delete(sessionID);
  }

  getStats(sessionID: string) {
    const buffer = this.buffers.get(sessionID);
    if (!buffer) return null;

    return {
      lastCaptureTokens: buffer.lastCaptureTokens,
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

    await ctx.client?.tui
      .showToast({
        body: {
          title: "Auto-Capture",
          message: "Analyzing conversation...",
          variant: "info",
          duration: 2000,
        },
      })
      .catch(() => {});

    if (!ctx.client) {
      throw new Error("Client not available");
    }

    const response = await ctx.client.session.messages({
      path: { id: sessionID },
    });

    if (!response.data) {
      log("Auto-capture failed: no data in response", { sessionID });
      service.clearBuffer(sessionID);
      return;
    }

    const allMessages = response.data;

    if (allMessages.length === 0) {
      service.clearBuffer(sessionID);
      return;
    }

    const buffer = service.getOrCreateBuffer(sessionID);
    const lastIndex = buffer.lastCapturedMessageIndex;

    if (allMessages.length <= lastIndex) {
      buffer.lastCapturedMessageIndex = -1;
      log("Auto-capture: message deletion detected, resetting index", { sessionID });
    }

    const contextWindow = CONFIG.autoCaptureContextWindow;
    const startIndex = Math.max(0, lastIndex - contextWindow + 1);
    const messagesToAnalyze = allMessages.slice(startIndex);

    if (messagesToAnalyze.length === 0) {
      service.clearBuffer(sessionID);
      return;
    }

    const userMessages = messagesToAnalyze.filter((m: any) => m?.info?.role === "user");
    const assistantMessages = messagesToAnalyze.filter((m: any) => m?.info?.role === "assistant");

    if (userMessages.length === 0 || assistantMessages.length === 0) {
      service.clearBuffer(sessionID);
      return;
    }

    let hasCompletePair = false;
    for (let i = 0; i < messagesToAnalyze.length - 1; i++) {
      const current = messagesToAnalyze[i];
      const next = messagesToAnalyze[i + 1];
      if (current?.info?.role === "user" && next?.info?.role === "assistant") {
        hasCompletePair = true;
        break;
      }
    }

    if (!hasCompletePair) {
      service.clearBuffer(sessionID);
      return;
    }

    const conversationParts: string[] = [];

    for (let i = 0; i < messagesToAnalyze.length; i++) {
      const msg = messagesToAnalyze[i];
      if (!msg) continue;

      const globalIndex = startIndex + i;
      const isNewMessage = globalIndex > lastIndex;

      const role = msg.info?.role;
      if (role !== "user" && role !== "assistant") continue;

      const roleLabel = role.toUpperCase();
      const marker = isNewMessage ? "[NEW]" : "[CONTEXT]";
      let content = "";

      if (msg.parts && Array.isArray(msg.parts)) {
        const textParts = msg.parts.filter((p: any) => p.type === "text" && p.text);
        content = textParts.map((p: any) => p.text).join("\n");

        const toolParts = msg.parts.filter((p: any) => p.type === "tool");
        if (toolParts.length > 0) {
          content += "\n[Tools: " + toolParts.map((p: any) => p.name || "unknown").join(", ") + "]";
        }
      }

      if (content) {
        conversationParts.push(`${marker} ${roleLabel}: ${content}`);
      }
    }

    if (conversationParts.length === 0) {
      service.clearBuffer(sessionID);
      return;
    }

    const conversationBody = conversationParts.join("\n\n");
    const newMessageCount = allMessages.length - lastIndex - 1;
    const contextMessageCount = messagesToAnalyze.length - newMessageCount;

    const conversationText = `=== CONVERSATION TO ANALYZE ===

Metadata:
- Total messages in session: ${allMessages.length}
- Messages in this analysis: ${messagesToAnalyze.length}
- Context messages (already captured): ${contextMessageCount}
- New messages (focus here): ${newMessageCount}
${lastIndex >= 0 ? `- Previous capture ended at message index: ${lastIndex}` : "- This is the first capture for this session"}

The following is a past conversation between a USER and an AI ASSISTANT.
Extract meaningful memories from this conversation.

${conversationBody}

=== END OF CONVERSATION ===`;

    const systemPrompt = service.getSystemPrompt(lastIndex >= 0);

    const captureResponse = await summarizeWithAI(ctx, sessionID, systemPrompt, conversationText);

    if (!captureResponse || !captureResponse.memories || captureResponse.memories.length === 0) {
      service.clearBuffer(sessionID);
      return;
    }

    const tags = getTags(directory);
    const results: Array<{ scope: string; id: string }> = [];

    for (const memory of captureResponse.memories.slice(0, CONFIG.autoCaptureMaxMemories)) {
      if (!memory.summary || !memory.scope || !memory.type) continue;

      const tagInfo = memory.scope === "user" ? tags.user : tags.project;

      const result = await memoryClient.addMemory(memory.summary, tagInfo.tag, {
        type: memory.type,
        source: "auto-capture",
        sessionID,
        reasoning: memory.reasoning,
        captureTimestamp: Date.now(),
        displayName: tagInfo.displayName,
        userName: tagInfo.userName,
        userEmail: tagInfo.userEmail,
        projectPath: tagInfo.projectPath,
        projectName: tagInfo.projectName,
        gitRepoUrl: tagInfo.gitRepoUrl,
      });

      if (result.success) {
        results.push({ scope: memory.scope, id: result.id });
      }
    }

    if (results.length === 0) {
      service.clearBuffer(sessionID);
      return;
    }

    const userCount = results.filter((r) => r.scope === "user").length;
    const projectCount = results.filter((r) => r.scope === "project").length;

    await ctx.client?.tui
      .showToast({
        body: {
          title: "Memory Captured",
          message: `Saved ${userCount} user + ${projectCount} project memories`,
          variant: "success",
          duration: 3000,
        },
      })
      .catch(() => {});

    log("Auto-capture: success", {
      sessionID,
      userCount,
      projectCount,
      total: results.length,
    });

    buffer.lastCapturedMessageIndex = allMessages.length - 1;
    service.clearBuffer(sessionID);
  } catch (error) {
    log("Auto-capture error", { sessionID, error: String(error) });

    await ctx.client?.tui
      .showToast({
        body: {
          title: "Auto-Capture Failed",
          message: String(error),
          variant: "error",
          duration: 5000,
        },
      })
      .catch(() => {});

    service.clearBuffer(sessionID);
  }
}

async function summarizeWithAI(
  ctx: PluginInput,
  sessionID: string,
  systemPrompt: string,
  conversationPrompt: string
): Promise<CaptureResponse> {
  if (!ctx.client) {
    throw new Error("Client not available");
  }

  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl || !CONFIG.memoryApiKey) {
    throw new Error(
      "External API not configured. Auto-capture requires memoryModel, memoryApiUrl, and memoryApiKey."
    );
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");

  AIProviderFactory.initializeSessionStore(CONFIG.storagePath, CONFIG.aiSessionRetentionDays);

  const providerConfig = {
    model: CONFIG.memoryModel,
    apiUrl: CONFIG.memoryApiUrl,
    apiKey: CONFIG.memoryApiKey,
    maxIterations: CONFIG.autoCaptureMaxIterations,
    iterationTimeout: CONFIG.autoCaptureIterationTimeout,
  };

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const toolSchema = createToolCallSchema();
  const result = await provider.executeToolCall(systemPrompt, conversationPrompt, toolSchema, sessionID);

  if (!result.success) {
    throw new Error(result.error || "Tool call failed");
  }

  log("Auto-capture: AI execution completed", {
    sessionID,
    provider: provider.getProviderName(),
    iterations: result.iterations,
  });

  return result.data;
}

function createToolCallSchema() {
  const summaryDescription =
    CONFIG.autoCaptureSummaryMaxLength > 0
      ? `Memory summary (maximum ${CONFIG.autoCaptureSummaryMaxLength} characters). Focus on most critical information.`
      : "Memory summary with key details and important information. Be concise but complete.";

  return {
    type: "function" as const,
    function: {
      name: "save_memories",
      description: "Save extracted memories from conversation analysis",
      parameters: {
        type: "object",
        properties: {
          memories: {
            type: "array",
            description: "Array of memories extracted from the conversation",
            items: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  description: summaryDescription,
                },
                scope: {
                  type: "string",
                  enum: ["user", "project"],
                  description:
                    "user: cross-project user preferences/behaviors. project: project-specific knowledge/decisions.",
                },
                type: {
                  type: "string",
                  description:
                    "Category of this memory (e.g., preference, architecture, workflow, bug-fix, configuration, pattern, etc). Choose the most appropriate category.",
                },
                reasoning: {
                  type: "string",
                  description: "Why this memory is important and worth retaining",
                },
              },
              required: ["summary", "scope", "type"],
            },
          },
        },
        required: ["memories"],
      },
    },
  };
}
