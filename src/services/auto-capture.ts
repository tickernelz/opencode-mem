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

    const context = buildMarkdownContext(prompt.content, textResponses, toolCalls);

    const summary = await generateSummary(ctx, context, sessionID);

    if (!summary) {
      log("Auto-capture: no summary generated", { sessionID });
      return;
    }

    const tags = getTags(directory);
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

function buildMarkdownContext(
  userPrompt: string,
  textResponses: string[],
  toolCalls: ToolCallInfo[]
): string {
  const sections: string[] = [];

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

  const systemPrompt = `You are a conversation summarizer for a coding assistant.

Your task is to analyze the conversation and save it as a memory using the save_memory tool.

The memory should:
- Be in markdown format
- Capture what the user requested
- Summarize what actions were taken
- Note the outcome or result
- Be concise but informative

Use the save_memory tool to save the summary.`;

  const userPrompt = `${context}

Analyze this conversation and save it as a project memory using the save_memory tool.`;

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
