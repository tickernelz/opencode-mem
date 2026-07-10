import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager, type UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";

interface ToolCallInfo {
  name: string;
  input: string;
}

const MAX_TOOL_INPUT_LENGTH = 100;
const RETRY_BASE_DELAY_MS = 2000;

let isCaptureRunning = false;

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string
): Promise<void> {
  if (isCaptureRunning) return;
  isCaptureRunning = true;

  try {
    const prompts = userPromptManager.getUncapturedPromptsForSession(sessionID);
    if (prompts.length === 0) {
      return;
    }

    if (!CONFIG.autoCaptureProviderStatus.ready) {
      return;
    }

    const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
    for (const prompt of prompts) {
      await capturePrompt(ctx, sessionID, directory, prompt, maxRetries);
    }
  } finally {
    isCaptureRunning = false;
  }
}

async function capturePrompt(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  prompt: UserPrompt,
  maxRetries: number
): Promise<void> {
  let claimedPromptId: string | null = null;
  let attempt = prompt.capture_attempts || 0;

  try {
    if (!userPromptManager.claimPrompt(prompt.id)) {
      return;
    }
    claimedPromptId = prompt.id;

    while (attempt < maxRetries) {
      attempt++;
      try {
        if (!ctx.client) {
          throw new Error("Client not available");
        }

        const response = await ctx.client.session.messages({
          path: { id: sessionID },
        });

        if (!response.data) {
          return;
        }

        const messages = response.data;
        const aiMessages = getAIResponseMessages(messages, prompt.messageId);
        if (aiMessages === null) {
          return;
        }
        if (aiMessages.length === 0) {
          return;
        }

        const { textResponses, toolCalls } = extractAIContent(aiMessages);
        if (textResponses.length === 0 && toolCalls.length === 0) {
          return;
        }

        const tags = getTags(directory);
        const latestMemory = await getLatestProjectMemory(tags.project.tag);
        const context = buildMarkdownContext(
          prompt.content,
          textResponses,
          toolCalls,
          latestMemory
        );

        let summaryResult: { summary: string; type: string; tags: string[] } | null;
        try {
          summaryResult = await generateSummary(context, sessionID, prompt.content, prompt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Summary generation failed: ${message}`);
        }

        if (!summaryResult || summaryResult.type === "skip") {
          log("Auto-capture skipped", {
            promptId: prompt.id,
            sessionID,
            type: summaryResult?.type,
          });
          userPromptManager.deletePrompt(prompt.id);
          claimedPromptId = null;
          return;
        }

        const summaryWithTags =
          summaryResult.tags && summaryResult.tags.length > 0
            ? `${summaryResult.summary}\n\nTags: ${summaryResult.tags.join(", ")}`
            : summaryResult.summary;

        const result = await memoryClient.addMemory(summaryWithTags, tags.project.tag, {
          source: "auto-capture" as any,
          type: summaryResult.type as any,
          tags: summaryResult.tags,
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
          claimedPromptId = null;
          log("Auto-capture memory persisted", {
            promptId: prompt.id,
            sessionID,
            memoryId: result.id,
          });

          if (CONFIG.showAutoCaptureToasts) {
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
          return;
        } else {
          throw new Error(`Memory persistence failed: ${result.error || "database write failed"}`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        userPromptManager.recordFailedAttempt(prompt.id);

        if (attempt < maxRetries) {
          log(`Auto-capture warning (attempt ${attempt}/${maxRetries})`, { error: errMsg });
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
          );
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log(`Auto-capture final error after ${attempt} attempts`, { error: errMsg });
    if (CONFIG.showErrorToasts) {
      const shortReason = errMsg.length > 100 ? errMsg.substring(0, 100) + "..." : errMsg;
      await ctx.client?.tui
        .showToast({
          body: {
            title: "Auto Capture Failed",
            message: shortReason,
            variant: "error",
            duration: 5000,
          },
        })
        .catch(() => {});
    }
  } finally {
    if (claimedPromptId !== null) {
      try {
        userPromptManager.releaseClaim(claimedPromptId);
      } catch (releaseErr) {
        log(
          `Failed to release captured=2 claim for prompt ${claimedPromptId}: ${
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
          }`
        );
      }
    }
  }
}

function getAIResponseMessages(messages: any[], promptMessageId: string): any[] | null {
  const promptIndex = messages.findIndex((m: any) => m.info?.id === promptMessageId);
  if (promptIndex === -1) return null;

  const responseMessages: any[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.info?.role === "user") break;
    responseMessages.push(message);
  }
  return responseMessages;
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
  sessionID: string,
  userPrompt: string,
  prompt?: { providerId: string | null; modelId: string | null }
): Promise<{ summary: string; type: string; tags: string[] } | null> {
  // Opencode provider path (when opencodeProvider + opencodeModel configured)
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    try {
      if (CONFIG.memoryModel) {
        log("opencodeProvider takes precedence over memoryModel for auto-capture");
      }

      const { isProviderConnected, getV2Client, generateStructuredOutput } =
        await loadOpencodeProvider();

      // "inherit" resolves to the model opencode used for the captured prompt
      // (recorded by the chat.params hook). Without a concrete model id, the
      // provider path cannot issue a structured-output request.
      let providerID = CONFIG.opencodeProvider;
      let modelID = CONFIG.opencodeModel;
      if (modelID === "inherit") {
        if (!prompt?.providerId || !prompt?.modelId) {
          throw new Error(
            "opencode-mem: opencodeModel is 'inherit' but no session model was recorded for this prompt"
          );
        }
        providerID = prompt.providerId;
        modelID = prompt.modelId;
      }

      if (!isProviderConnected(providerID)) {
        throw new Error(
          `opencode provider '${providerID}' is not connected. Check your opencode provider configuration.`
        );
      }

      const v2Client = getV2Client();
      if (!v2Client) {
        throw new Error(
          "opencode-mem: v2 client not initialized; cannot perform structured-output capture"
        );
      }

      const { detectLanguage, getLanguageName } = await import("./language-detector.js");
      const targetLang =
        CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
          ? detectLanguage(userPrompt)
          : CONFIG.autoCaptureLanguage;
      const langName = getLanguageName(targetLang);

      const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.

FORMAT:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;

      const aiPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

      const { z } = await import("zod");
      const schema = z.object({
        summary: z.string(),
        type: z.string(),
        tags: z.array(z.string()),
      });

      const result = await generateStructuredOutput({
        client: v2Client,
        providerID,
        modelID,
        systemPrompt,
        userPrompt: aiPrompt,
        schema,
      });

      return {
        summary: result.summary,
        type: result.type,
        tags: (result.tags || []).map((t: string) => t.toLowerCase().trim()),
      };
    } catch (e) {
      log("auto-capture: opencode provider failed, falling back to external API", {
        error: String(e),
      });
    }
  }

  // Existing manual config path
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    throw new Error("External API not configured for auto-capture");
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
  const { detectLanguage, getLanguageName } = await import("./language-detector.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const targetLang =
    CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
      ? detectLanguage(userPrompt)
      : CONFIG.autoCaptureLanguage;

  const langName = getLanguageName(targetLang);

  const systemPrompt = `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.

FORMAT:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;

  const aiPrompt = `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

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
          tags: {
            type: "array",
            items: { type: "string" },
            description: "List of 2-4 technical tags related to the memory",
          },
        },
        required: ["summary", "type", "tags"],
      },
    },
  };

  const result = await provider.executeToolCall(systemPrompt, aiPrompt, toolSchema, sessionID);

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to generate summary");
  }

  return {
    summary: result.data.summary,
    type: result.data.type,
    tags: (result.data.tags || []).map((t: string) => t.toLowerCase().trim()),
  };
}
