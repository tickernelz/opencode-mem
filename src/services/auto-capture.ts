import type { PluginInput } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager, type UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { truncateToMaxBytes, utf8ByteLength } from "../utils/context-limit.js";

interface ToolCallInfo {
  name: string;
  input: string;
}

const MAX_TOOL_INPUT_LENGTH = 100;
const RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES = 131072;
const CONTEXT_TRUNCATION_MARKER = "\n[... truncated to autoCaptureMaxContextBytes ...]\n";
const SUMMARY_REQUEST_OVERHEAD_BYTES = 1024;
const SUMMARY_OUTPUT_RESERVE_BYTES = 16384;
const SUMMARY_ANALYSIS_SUFFIX = `Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

let isCaptureRunning = false;

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string
): Promise<void> {
  if (isCaptureRunning) return;
  isCaptureRunning = true;

  try {
    const prompts = await userPromptManager.getUncapturedPromptsForSession(sessionID);
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
    if (!(await userPromptManager.claimPrompt(prompt.id))) {
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
          latestMemory,
          getAutoCaptureMarkdownBudget()
        );

        let summaryResult: { summary: string; type: string; tags: string[] } | null;
        try {
          summaryResult = await generateSummary(ctx, context, sessionID, prompt.content, prompt);
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
          await userPromptManager.deletePrompt(prompt.id);
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
          await userPromptManager.linkMemoryToPrompt(prompt.id, result.id);
          await userPromptManager.markAsCaptured(prompt.id);
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

        await userPromptManager.recordFailedAttempt(prompt.id);

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
        await userPromptManager.releaseClaim(claimedPromptId);
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

function fitTextResponses(textResponses: string[], maxBytes: number): string {
  if (textResponses.length === 0 || maxBytes <= 0) return "";

  const separator = "\n\n";
  const separatorBytes = utf8ByteLength(separator);
  const joined = textResponses.join(separator);
  if (utf8ByteLength(joined) <= maxBytes) return joined;

  // Prefer newest assistant turns; truncate older content first.
  const kept: string[] = [];
  let usedBytes = 0;

  for (let i = textResponses.length - 1; i >= 0; i--) {
    const response = textResponses[i] ?? "";
    const responseBytes = utf8ByteLength(response);
    const extraSeparator = kept.length > 0 ? separatorBytes : 0;
    const needed = responseBytes + extraSeparator;

    if (usedBytes + needed <= maxBytes) {
      kept.unshift(response);
      usedBytes += needed;
      continue;
    }

    const remaining = maxBytes - usedBytes - extraSeparator;
    if (remaining > utf8ByteLength(CONTEXT_TRUNCATION_MARKER)) {
      kept.unshift(truncateToMaxBytes(response, remaining, CONTEXT_TRUNCATION_MARKER));
    }
    break;
  }

  return kept.join(separator);
}

function joinSections(sections: string[]): string {
  return sections.join("\n");
}

export function getAutoCaptureMarkdownBudget(
  totalRequestBytes: number = CONFIG.autoCaptureMaxContextBytes ??
    DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES
): number {
  const requestReserve = Math.min(24576, Math.floor(totalRequestBytes * 0.25));
  return Math.max(4096, totalRequestBytes - requestReserve);
}

export function buildBoundedSummaryPrompt(
  context: string,
  systemPrompt: string,
  schema: unknown,
  totalRequestBytes: number = CONFIG.autoCaptureMaxContextBytes ??
    DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES
): string {
  const schemaBytes = utf8ByteLength(JSON.stringify(schema));
  const outputReserve = Math.min(
    SUMMARY_OUTPUT_RESERVE_BYTES,
    Math.floor(totalRequestBytes * 0.125)
  );
  const userBudget = Math.max(
    0,
    totalRequestBytes -
      utf8ByteLength(systemPrompt) -
      schemaBytes -
      outputReserve -
      SUMMARY_REQUEST_OVERHEAD_BYTES
  );
  return truncateToMaxBytes(
    `${context}\n\n${SUMMARY_ANALYSIS_SUFFIX}`,
    userBudget,
    CONTEXT_TRUNCATION_MARKER
  );
}

/** Build auto-capture markdown context, capped to autoCaptureMaxContextBytes (UTF-8). */
export function buildMarkdownContext(
  userPrompt: string,
  textResponses: string[],
  toolCalls: ToolCallInfo[],
  latestMemory: string | null,
  maxContextBytes: number = CONFIG.autoCaptureMaxContextBytes ??
    DEFAULT_AUTO_CAPTURE_MAX_CONTEXT_BYTES
): string {
  const memorySections: string[] = [];
  if (latestMemory) {
    memorySections.push(`## Previous Memory Context`);
    memorySections.push(`---`);
    memorySections.push(latestMemory);
    memorySections.push(`---\n`);
  }

  const toolsSections: string[] = [];
  if (toolCalls.length > 0) {
    toolsSections.push(`## Tools Used`);
    toolsSections.push(`---`);
    for (const tool of toolCalls) {
      if (tool.input) {
        toolsSections.push(`- ${tool.name}(${tool.input})`);
      } else {
        toolsSections.push(`- ${tool.name}`);
      }
    }
    toolsSections.push(`---\n`);
  }

  const userWrapper = ["## User Request", "---", "", "---\n"];
  const aiWrapper =
    textResponses.length > 0 ? ["## AI Response", "---", "", "---\n"] : ([] as string[]);

  const skeletonWithoutBodies = joinSections([
    ...memorySections,
    ...userWrapper,
    ...aiWrapper,
    ...toolsSections,
  ]);
  const skeletonBytes = utf8ByteLength(skeletonWithoutBodies);

  let userBudget = Math.max(0, maxContextBytes - skeletonBytes);
  if (textResponses.length > 0 && userBudget > 1024) {
    const preferredAiFloor = Math.min(4096, Math.floor(maxContextBytes * 0.25));
    userBudget = Math.max(256, userBudget - preferredAiFloor);
  }

  const boundedUser =
    utf8ByteLength(userPrompt) <= userBudget
      ? userPrompt
      : truncateToMaxBytes(userPrompt, userBudget, CONTEXT_TRUNCATION_MARKER);

  const prefix = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    boundedUser,
    "---\n",
    ...toolsSections,
  ]);

  if (textResponses.length === 0) {
    if (utf8ByteLength(prefix) <= maxContextBytes) return prefix;
    return truncateToMaxBytes(prefix, maxContextBytes, CONTEXT_TRUNCATION_MARKER);
  }

  // Insert AI section before tools to preserve the historical section order.
  const prefixWithoutTools = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    boundedUser,
    "---\n",
  ]);
  const toolsBlock = toolsSections.length > 0 ? "\n" + joinSections(toolsSections) : "";
  const aiWrapperBytes = utf8ByteLength(joinSections(["## AI Response", "---", "", "---\n"]));
  const aiBudget = Math.max(
    0,
    maxContextBytes -
      utf8ByteLength(prefixWithoutTools) -
      utf8ByteLength(toolsBlock) -
      aiWrapperBytes
  );
  const boundedAi = fitTextResponses(textResponses, aiBudget);

  const result = joinSections([
    ...memorySections,
    "## User Request",
    "---",
    boundedUser,
    "---\n",
    "## AI Response",
    "---",
    boundedAi,
    "---\n",
    ...toolsSections,
  ]);

  if (utf8ByteLength(result) <= maxContextBytes) return result;
  return truncateToMaxBytes(result, maxContextBytes, CONTEXT_TRUNCATION_MARKER);
}

async function generateSummary(
  ctx: PluginInput,
  context: string,
  sessionID: string,
  userPrompt: string,
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<{ summary: string; type: string; tags: string[] } | null> {
  let opencodeProviderError: unknown;

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

      const { z } = await import("zod");
      const schema = z.object({
        summary: z.string(),
        type: z.string(),
        tags: z.array(z.string()),
      });
      const aiPrompt = buildBoundedSummaryPrompt(context, systemPrompt, z.toJSONSchema(schema));

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
      opencodeProviderError = e;
      log("auto-capture: opencode provider failed, falling back to external API", {
        error: String(e),
      });
    }
  }

  // Existing manual config path
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    if (opencodeProviderError) {
      throw opencodeProviderError;
    }
    throw new Error("External API not configured for auto-capture");
  }

  // Opencode provider failed but a manual fallback is configured — surface a
  // non-blocking warning so the user knows their primary provider is broken.
  if (opencodeProviderError && CONFIG.showErrorToasts) {
    const errMsg =
      opencodeProviderError instanceof Error
        ? opencodeProviderError.message
        : String(opencodeProviderError);
    const shortReason = errMsg.length > 100 ? errMsg.substring(0, 100) + "..." : errMsg;
    ctx.client?.tui
      .showToast({
        body: {
          title: "Using fallback provider",
          message: `OpenCode provider failed (${shortReason}); using configured fallback.`,
          variant: "warning",
          duration: 5000,
        },
      })
      .catch(() => {});
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
  const aiPrompt = buildBoundedSummaryPrompt(context, systemPrompt, toolSchema);
  const captureSessionID = `auto-capture-${prompt?.id ?? sessionID}-${randomUUID()}`;

  const result = await provider.executeToolCall(
    systemPrompt,
    aiPrompt,
    toolSchema,
    captureSessionID
  );

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to generate summary");
  }

  return {
    summary: result.data.summary,
    type: result.data.type,
    tags: (result.data.tags || []).map((t: string) => t.toLowerCase().trim()),
  };
}
