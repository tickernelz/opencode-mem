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

    const summaryResult = await generateSummary(context, sessionID);

    if (!summaryResult || summaryResult.type === "skip") {
      log("Auto-capture: skipped non-technical conversation", { sessionID });
      userPromptManager.deletePrompt(prompt.id);
      return;
    }

    const result = await memoryClient.addMemory(summaryResult.summary, tags.project.tag, {
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
    const result = await memoryClient.listMemories(containerTag, 1);
    log("Auto-capture: latest memory list result", { result });
    log("Auto-capture: container tag", { containerTag });
    if (!result.success || result.memories.length === 0) {
      return null;
    }

    const latest = result.memories[0];
    if (!latest) {
      return null;
    }

    const content = latest.summary;

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
    sections.push(`## Previous Memory Context`);
    sections.push(`---`);
    sections.push(latestMemory);
    sections.push(`---\n`);
  }

  sections.push(`## User Request`);
  sections.push(`---`);
  sections.push(userPrompt);
  sections.push(`---\n`);

  if (textResponses.length > 0) {
    sections.push(`## AI Response`);
    sections.push(`---`);
    sections.push(textResponses.join("\n\n"));
    sections.push(`---\n`);
  }

  if (toolCalls.length > 0) {
    sections.push(`## Tools Used`);
    sections.push(`---`);
    for (const tool of toolCalls) {
      if (tool.input) {
        sections.push(`- ${tool.name}(${tool.input})`);
      } else {
        sections.push(`- ${tool.name}`);
      }
    }
    sections.push(`---\n`);
  }

  return sections.join("\n");
}

async function generateSummary(
  context: string,
  sessionID: string
): Promise<{ summary: string; type: string } | null> {
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

  const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details

FORMAT:
## Request
[1-2 sentences: what was requested]

## Outcome
[1-2 sentences: what was done, include files/functions]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made

EXAMPLES:
Technical → type="feature":
## Request
Fix function returning null.
## Outcome
Changed searchMemories() to listMemories() in auto-capture.ts:166.

Non-technical → type="skip", summary="":
User greeted, AI introduced capabilities.`;

  const userPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

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
              "Type of memory: 'skip' for non-technical conversations, or technical type (feature, bug-fix, refactor, analysis, configuration, discussion, other)",
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

  return {
    summary: result.data.summary,
    type: result.data.type,
  };
}
