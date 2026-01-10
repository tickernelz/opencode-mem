import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { MemoryType } from "../types/index.js";

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
  lastCaptureTokens: number;
  messages: MessageEntry[];
  tools: ToolEntry[];
  lastCaptureTime: number;
  fileEdits: number;
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
    
    this.enabled = CONFIG.autoCaptureEnabled && 
                   !!CONFIG.memoryModel && 
                   !!CONFIG.memoryApiUrl && 
                   !!CONFIG.memoryApiKey;
    
    if (CONFIG.autoCaptureEnabled && !this.enabled) {
      log("Auto-capture disabled: external API not configured (memoryModel, memoryApiUrl, memoryApiKey required)");
    }
    
    if (this.enabled && CONFIG.memoryApiUrl?.includes('ollama')) {
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

  private getOrCreateBuffer(sessionID: string): CaptureBuffer {
    if (!this.buffers.has(sessionID)) {
      this.buffers.set(sessionID, {
        sessionID,
        lastCaptureTokens: 0,
        messages: [],
        tools: [],
        lastCaptureTime: Date.now(),
        fileEdits: 0,
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

    const summaryGuidance = CONFIG.autoCaptureSummaryMaxLength > 0
      ? `Keep summaries under ${CONFIG.autoCaptureSummaryMaxLength} characters.`
      : "Extract key details and important information. Be concise but complete.";

    return `Analyze the recent conversation and extract distinct, actionable memories.

Categorize each memory by scope:
- "user": Cross-project user behaviors, preferences, patterns (e.g., "prefers TypeScript", "likes concise responses")
- "project": Project-specific knowledge, decisions, architecture (e.g., "uses Bun runtime", "API at /api/v1")

Memory categorization:
- Choose appropriate category/type for each memory (e.g., preference, architecture, workflow, bug-fix, configuration, pattern, etc)
- Be specific and descriptive with categories

Summary guidelines:
- ${summaryGuidance}
- Only extract memories worth long-term retention
- Be selective: quality over quantity
- Each memory should be atomic and independent
- Maximum ${this.maxMemories} memories per capture

Conversation:
${conversationText}${toolsText}`;
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
      lastCaptureTokens: buffer.lastCaptureTokens,
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
        message: "Analyzing conversation...",
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

    const captureResponse = await summarizeWithAI(ctx, sessionID, prompt);
    if (!captureResponse || !captureResponse.memories || captureResponse.memories.length === 0) {
      log("Auto-capture: no memories extracted", { sessionID });
      service.clearBuffer(sessionID);
      return;
    }

    const tags = getTags(directory);
    const results: Array<{ scope: string; id: string }> = [];

    for (const memory of captureResponse.memories.slice(0, CONFIG.autoCaptureMaxMemories)) {
      if (!memory.summary || !memory.scope || !memory.type) {
        log("Auto-capture: invalid memory entry", { memory });
        continue;
      }

      const containerTag = memory.scope === "user" ? tags.user : tags.project;

      const result = await memoryClient.addMemory(
        memory.summary,
        containerTag,
        {
          type: memory.type,
          source: "auto-capture",
          sessionID,
          reasoning: memory.reasoning,
          captureTimestamp: Date.now(),
        }
      );

      if (result.success) {
        results.push({ scope: memory.scope, id: result.id });
        log("Auto-capture: memory saved", {
          scope: memory.scope,
          type: memory.type,
          id: result.id,
        });
      }
    }

    if (results.length === 0) {
      log("Auto-capture: no memories captured", { sessionID });
      service.clearBuffer(sessionID);
      return;
    }

    const userCount = results.filter(r => r.scope === "user").length;
    const projectCount = results.filter(r => r.scope === "project").length;

    await ctx.client?.tui.showToast({
      body: {
        title: "Memory Captured",
        message: `Saved ${userCount} user + ${projectCount} project memories`,
        variant: "success",
        duration: 3000,
      },
    }).catch(() => {});

    log("Auto-capture: success", {
      sessionID,
      userCount,
      projectCount,
      total: results.length,
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
): Promise<CaptureResponse> {
  if (!ctx.client) {
    throw new Error("Client not available");
  }

  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl || !CONFIG.memoryApiKey) {
    throw new Error("External API not configured. Auto-capture requires memoryModel, memoryApiUrl, and memoryApiKey.");
  }

  return await callExternalAPIWithToolCalling(prompt);
}

function createToolCallSchema() {
  const summaryDescription = CONFIG.autoCaptureSummaryMaxLength > 0
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
                  description: summaryDescription
                },
                scope: {
                  type: "string",
                  enum: ["user", "project"],
                  description: "user: cross-project user preferences/behaviors. project: project-specific knowledge/decisions."
                },
                type: {
                  type: "string",
                  description: "Category of this memory (e.g., preference, architecture, workflow, bug-fix, configuration, pattern, etc). Choose the most appropriate category."
                },
                reasoning: {
                  type: "string",
                  description: "Why this memory is important and worth retaining"
                }
              },
              required: ["summary", "scope", "type"]
            }
          }
        },
        required: ["memories"]
      }
    }
  };
}

async function callExternalAPIWithToolCalling(prompt: string): Promise<CaptureResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const tools = [createToolCallSchema()];
    
    const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.memoryApiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.memoryModel,
        messages: [{ role: "user", content: prompt }],
        tools: tools,
        tool_choice: { type: "function", function: { name: "save_memories" } },
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as ToolCallResponse;
    
    if (!data.choices || !data.choices[0]) {
      throw new Error("Invalid API response format");
    }

    const choice = data.choices[0];
    
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      throw new Error("Tool calling not supported or not used by provider");
    }
    
    const toolCall = choice.message.tool_calls[0];
    if (!toolCall || toolCall.function.name !== "save_memories") {
      throw new Error("Invalid tool call response");
    }
    
    const parsed = JSON.parse(toolCall.function.arguments);
    return validateCaptureResponse(parsed);
    
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("API request timeout (30s)");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateCaptureResponse(data: any): CaptureResponse {
  if (!data || typeof data !== 'object') {
    throw new Error("Response is not an object");
  }
  
  if (!Array.isArray(data.memories)) {
    throw new Error("memories field is not an array");
  }
  
  const validMemories = data.memories.filter((m: any) => {
    return m && 
           typeof m === 'object' && 
           typeof m.summary === 'string' && 
           m.summary.trim().length > 0 &&
           (m.scope === 'user' || m.scope === 'project') &&
           typeof m.type === 'string' &&
           m.type.trim().length > 0;
  });
  
  if (validMemories.length === 0) {
    throw new Error("No valid memories in response");
  }
  
  return { memories: validMemories };
}
