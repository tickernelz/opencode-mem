import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface ToolCallInfo {
  name: string;
  input: string;
}

const MAX_TOOL_INPUT_LENGTH = 100;

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string
): Promise<void> {
  try {
    const prompt = userPromptManager.getLastUncapturedPrompt(sessionID);
    if (!prompt) {
      return;
    }

    if (!ctx.client) {
      throw new Error("Client not available");
    }

    const response = await ctx.client.session.messages({
      path: { id: sessionID },
    });

    if (!response.data) {
      log("Auto-capture: no messages in session", { sessionID });
      return;
    }

    const messages = response.data;

    const promptIndex = messages.findIndex((m: any) => m.info?.id === prompt.messageId);
    if (promptIndex === -1) {
      log("Auto-capture: prompt message not found", { sessionID, messageId: prompt.messageId });
      return;
    }

    const aiMessages = messages.slice(promptIndex + 1);

    if (aiMessages.length === 0) {
      return;
    }

    const { textResponses, toolCalls } = extractAIContent(aiMessages);

    if (textResponses.length === 0 && toolCalls.length === 0) {
      return;
    }

    const tags = getTags(directory);
    const latestMemory = await getLatestProjectMemory(tags.project.tag);

    const context = buildMarkdownContext(prompt.content, textResponses, toolCalls, latestMemory);

    const summary = await generateSummary(ctx, context, sessionID);

    if (!summary) {
      log("Auto-capture: no summary generated", { sessionID });
      return;
    }

    const result = await memoryClient.addMemory(summary, tags.project.tag, {
      source: "auto-capture" as any,
      sessionID,
      promptId: prompt.id,
      captureTimestamp: Date.now(),
      displayName: tags.project.displayName,
      userName: tags.project.userName,
      userEmail: tags.project.userEmail,
      projectPath: tags.project.projectPath,
      projectName: tags.project.projectName,
      gitRepoUrl: tags.project.gitRepoUrl,
    });

    if (result.success) {
      userPromptManager.linkMemoryToPrompt(prompt.id, result.id);
      userPromptManager.markAsCaptured(prompt.id);

      await ctx.client?.tui
        .showToast({
          body: {
            title: "Memory Captured",
            message: "Project memory saved from conversation",
            variant: "success",
            duration: 3000,
          },
        })
        .catch(() => {});
    }
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
  }
}

function extractAIContent(messages: any[]): {
  textResponses: string[];
  toolCalls: ToolCallInfo[];
} {
  const textResponses: string[] = [];
  const toolCalls: ToolCallInfo[] = [];

  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;

    if (!msg.parts || !Array.isArray(msg.parts)) continue;

    const textParts = msg.parts.filter((p: any) => p.type === "text" && p.text);
    if (textParts.length > 0) {
      const text = textParts.map((p: any) => p.text).join("\n");
      if (text.trim()) {
        textResponses.push(text.trim());
      }
    }

    const toolParts = msg.parts.filter((p: any) => p.type === "tool");
    for (const tool of toolParts) {
      const name = tool.tool || "unknown";
      let input = "";

      if (tool.state?.input) {
        const inputObj = tool.state.input;
        if (typeof inputObj === "string") {
          input = inputObj;
        } else if (typeof inputObj === "object") {
          const params = [];
          for (const [key, value] of Object.entries(inputObj)) {
            params.push(`${key}: ${JSON.stringify(value)}`);
          }
          input = params.join(", ");
        }
      }

      if (input.length > MAX_TOOL_INPUT_LENGTH) {
        input = input.substring(0, MAX_TOOL_INPUT_LENGTH) + "...";
      }

      toolCalls.push({ name, input });
    }
  }

  return { textResponses, toolCalls };
}

async function getLatestProjectMemory(containerTag: string): Promise<string | null> {
  try {
    const result = await memoryClient.searchMemories("", containerTag);
    log("Auto-capture: latest memory search result", { result });
    log("Auto-capture: container tag", { containerTag });
    if (!result.success || result.results.length === 0) {
      return null;
    }

    const latest = result.results[0];
    if (!latest) {
      return null;
    }

    const content = latest.memory;

    if (content.length <= 500) {
      return content;
    }

    return content.substring(0, 500) + "...";
  } catch {
    return null;
  }
}

function buildMarkdownContext(
  userPrompt: string,
  textResponses: string[],
  toolCalls: ToolCallInfo[],
  latestMemory: string | null
): string {
  const sections: string[] = [];

  if (latestMemory) {
    sections.push(`## Previous Memory Context\n${latestMemory}\n`);
  }

  sections.push(`## User Request\n${userPrompt}\n`);

  if (textResponses.length > 0) {
    sections.push(`## AI Response\n\n${textResponses.join("\n\n")}\n`);
  }

  if (toolCalls.length > 0) {
    sections.push(`### Tools Used`);
    for (const tool of toolCalls) {
      if (tool.input) {
        sections.push(`- ${tool.name}(${tool.input})`);
      } else {
        sections.push(`- ${tool.name}`);
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

async function generateSummary(ctx: PluginInput, context: string, sessionID: string): Promise<string> {
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl || !CONFIG.memoryApiKey) {
    throw new Error("External API not configured for auto-capture");
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");

  const providerConfig = {
    model: CONFIG.memoryModel,
    apiUrl: CONFIG.memoryApiUrl,
    apiKey: CONFIG.memoryApiKey,
    maxIterations: CONFIG.autoCaptureMaxIterations,
    iterationTimeout: CONFIG.autoCaptureIterationTimeout,
  };

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const systemPrompt = `You are a professional conversation summarizer for a coding assistant.

Your task is to analyze the conversation and save it as a memory using the save_memory tool.

The conversation may include a "Previous Memory Context" section showing the most recent memory from this project. Use this context to understand continuity and avoid redundancy.

The summary MUST follow this exact markdown structure:

## Request
[What the user asked - 2-3 sentences maximum]

## Outcome
[What was accomplished and the result - 2-3 sentences maximum]

Requirements:
- Use professional technical language
- Be concise and factual
- NO emojis or decorative elements
- Focus on technical details and results
- Consider previous context to maintain continuity

Use the save_memory tool to save the summary.`;

  const userPrompt = `${context}

Analyze this conversation and create a professional summary following the exact markdown template provided. Use the save_memory tool to save it.`;

  const toolSchema = {
    type: "function" as const,
    function: {
      name: "save_memory",
      description: "Save the conversation summary as a memory",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Markdown-formatted summary of the conversation",
          },
          type: {
            type: "string",
            description:
              "Type of memory (e.g., feature, bug-fix, refactor, analysis, configuration, etc)",
          },
        },
        required: ["summary", "type"],
      },
    },
  };

  const result = await provider.executeToolCall(systemPrompt, userPrompt, toolSchema, sessionID);

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to generate summary");
  }

  return result.data.summary;
}
