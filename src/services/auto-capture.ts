import type { PluginInput } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log, serializeError } from "./logger.js";
import { sanitizeMemoryContent, sanitizeMemoryField } from "./privacy.js";
import { CONFIG } from "../config.js";
import { userPromptManager, type UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { truncateToMaxBytes, utf8ByteLength } from "../utils/context-limit.js";
import {
  applyUpdateOnCaptureDecision,
  buildUpdateOnCaptureDecisionPrompt,
  filterUpdateOnCaptureCandidates,
  type UpdateOnCaptureCandidate,
  type UpdateOnCaptureDecision,
} from "./update-on-capture.js";

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

// Serializes captures across sessions. Replacing the old module-wide boolean
// (which silently dropped any session whose idle fired while another capture
// was in flight — a finished session then never got summarized), jobs now
// queue behind the running one. The chain itself never rejects so one failed
// job cannot poison the next; each caller still observes its own job's
// actual outcome.
let captureChain: Promise<void> = Promise.resolve();

export interface PerformAutoCaptureOptions {
  /**
   * Skip this job if it has not started yet once the signal aborts (e.g. the
   * plugin is disposing). In-flight captures are NOT cancelled: model
   * requests were never cancellable and keep their original semantics.
   */
  signal?: AbortSignal;
  /**
   * Prefer durable ready evidence over a live host transcript lookup.
   * Used after session deletion and same-project startup replay, where the
   * host session is already gone. Normal idle capture keeps the live path.
   */
  preferSavedEvidence?: boolean;
}

export async function performAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  options: PerformAutoCaptureOptions = {}
): Promise<void> {
  const run = async () => {
    if (options.signal?.aborted) return;
    await runAutoCapture(ctx, sessionID, directory, options.preferSavedEvidence === true);
  };

  const next = captureChain.then(run, run);
  // Keep the chain alive regardless of this job's outcome; `next` still
  // rejects to the caller when their own job failed.
  captureChain = next.catch(() => {});
  return next;
}

/**
 * Wait until every capture job that has already been enqueued finishes.
 * Used by plugin dispose so the last `memoryClient.close()` (refcount → 0)
 * does not race an in-flight capture that was intentionally left uncancellable.
 */
export function awaitCaptureDrain(): Promise<void> {
  return captureChain;
}

async function runAutoCapture(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  preferSavedEvidence = false
): Promise<void> {
  const prompts = await userPromptManager.getUncapturedPromptsForSession(sessionID);
  if (prompts.length === 0) {
    return;
  }

  if (!CONFIG.autoCaptureProviderStatus.ready) {
    return;
  }

  const maxRetries = CONFIG.autoCaptureMaxRetries ?? 3;
  const host = { unavailable: false };
  for (const prompt of prompts) {
    if (
      prompt.projectPath &&
      prompt.projectPath.replace(/\\/g, "/") !== directory.replace(/\\/g, "/")
    )
      continue;
    // One missing host must not starve a later prompt with durable ready evidence.
    if (host.unavailable && !(await userPromptManager.getCaptureEvidence(prompt.id, directory)))
      continue;
    await capturePrompt(ctx, sessionID, directory, prompt, maxRetries, host, preferSavedEvidence);
  }
}

function isMissingSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; _tag?: unknown };
  return value.name === "Session.NotFoundError" || value._tag === "Session.NotFoundError";
}

function buildEvidenceContext(prompt: UserPrompt, savedEvidence: string): string {
  return buildMarkdownContext(
    sanitizeMemoryContent(prompt.content),
    [
      "Preserved observations from this request. Evidence may be bounded or partial; describe only observed outcomes, not inferred completion.\n" +
        savedEvidence,
    ],
    [],
    null,
    getAutoCaptureMarkdownBudget()
  );
}

async function capturePrompt(
  ctx: PluginInput,
  sessionID: string,
  directory: string,
  prompt: UserPrompt,
  maxRetries: number,
  host: { unavailable: boolean },
  preferSavedEvidence = false
): Promise<void> {
  let claimedPromptId: string | null = null;
  let attempt = prompt.capture_attempts || 0;
  let phase: "claim" | "context" | "summary" | "persist" = "claim";

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

        phase = "context";
        const tags = getTags(directory);
        const savedEvidence = await userPromptManager.getCaptureEvidence(prompt.id, directory);
        let context: string | undefined;

        // Deleted-session / startup replay: durable evidence is authoritative.
        // Normal idle keeps the richer live transcript and only falls back when
        // the host reports the session is gone.
        if (preferSavedEvidence && savedEvidence) {
          context = buildEvidenceContext(prompt, savedEvidence);
        } else if (preferSavedEvidence && !savedEvidence) {
          host.unavailable = true;
          log("Auto-capture skipped: session context unavailable; prompt retained", {
            phase,
            outcome: "skipped",
            reason: "session_not_found",
            promptId: prompt.id,
            sessionID,
            error: "Session.NotFoundError",
            name: "Session.NotFoundError",
          });
          return;
        } else if (!host.unavailable) {
          try {
            const response = await ctx.client.session.messages({
              path: { id: sessionID },
            });
            if ("error" in response && isMissingSessionError(response.error)) throw response.error;

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

            const latestMemory = await getLatestProjectMemory(tags.project.tag);
            context = buildMarkdownContext(
              prompt.content,
              textResponses,
              toolCalls,
              latestMemory,
              getAutoCaptureMarkdownBudget()
            );
          } catch (error) {
            if (!isMissingSessionError(error)) throw error;
            host.unavailable = true;
            if (savedEvidence) {
              context = buildEvidenceContext(prompt, savedEvidence);
            } else {
              // A session absent from this host may still exist in another desktop
              // or CLI instance. Keep the prompt eligible for a later idle event;
              // finally releases the claim without spending the capture retry budget.
              log("Auto-capture skipped: session context unavailable; prompt retained", {
                phase,
                outcome: "skipped",
                reason: "session_not_found",
                promptId: prompt.id,
                sessionID,
                ...serializeError(error),
              });
              return;
            }
          }
        } else if (savedEvidence) {
          context = buildEvidenceContext(prompt, savedEvidence);
        } else {
          log("Auto-capture skipped: session context unavailable; prompt retained", {
            phase,
            outcome: "skipped",
            reason: "session_not_found",
            promptId: prompt.id,
            sessionID,
            error: "Session.NotFoundError",
            name: "Session.NotFoundError",
          });
          return;
        }

        if (!context) {
          return;
        }

        phase = "summary";
        let summaryResult: { summary: string; type: string; tags: string[] } | null;
        try {
          summaryResult = await generateSummary(ctx, context, sessionID, prompt.content, prompt);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Summary generation failed: ${message}`, { cause: error });
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

        phase = "persist";
        const persistMeta = {
          source: "auto-capture" as const,
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
        };

        const result = await persistAutoCaptureMemory(
          ctx,
          sessionID,
          prompt,
          summaryWithTags,
          summaryResult.type,
          summaryResult.tags || [],
          tags.project.tag,
          persistMeta
        );

        if (result.success) {
          await userPromptManager.linkMemoryToPrompt(prompt.id, result.id!);
          await userPromptManager.markAsCaptured(prompt.id);
          claimedPromptId = null;
          log("Auto-capture memory persisted", {
            promptId: prompt.id,
            sessionID,
            memoryId: result.id,
            action: result.action,
          });

          if (CONFIG.showAutoCaptureToasts) {
            const action = result.action || "add";
            const toastByAction: Record<string, { title: string; message: string }> = {
              add: {
                title: "Memory Captured",
                message: "Project memory saved from conversation",
              },
              update: {
                title: "Memory Updated",
                message: "Similar existing memory was rewritten with current facts",
              },
              supersede: {
                title: "Memory Superseded",
                message: "New memory saved; outdated entry moved to trash",
              },
            };
            const toast = toastByAction[action] ?? toastByAction.add!;
            await ctx.client?.tui
              .showToast({
                body: {
                  title: toast.title,
                  message: toast.message,
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
        await userPromptManager.recordFailedAttempt(prompt.id);

        if (attempt < maxRetries) {
          log(`Auto-capture warning (attempt ${attempt}/${maxRetries})`, {
            phase,
            ...serializeError(error),
          });
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1))
          );
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    const errMsg = serializeError(error).error;
    log(`Auto-capture final error after ${attempt} attempts`, {
      phase,
      ...serializeError(error),
    });
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

export function extractAIContent(messages: any[]): {
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
      const name = tool.name || tool.tool || "unknown";
      let input = "";

      if (tool.state?.input) {
        const inputObj = tool.state.input;
        if (typeof inputObj === "string") {
          input = inputObj;
        } else if (typeof inputObj === "object") {
          const params = [];
          for (const [key, value] of Object.entries(inputObj)) {
            params.push(
              `${key}: ${JSON.stringify(sanitizeMemoryField(key, value), sanitizeMemoryField)}`
            );
          }
          input = params.join(", ");
        }
      }

      input = sanitizeMemoryContent(input);
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

    const content = sanitizeMemoryContent(latest.summary);

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
  // Redact complete available text before any length budget can cut a credential
  // (or its private-tag/PEM opener) away from the rest of its value.
  userPrompt = sanitizeMemoryContent(userPrompt);
  textResponses = textResponses.map(sanitizeMemoryContent);
  toolCalls = toolCalls.map((tool) => ({
    name: sanitizeMemoryContent(tool.name),
    input: sanitizeMemoryContent(tool.input),
  }));
  latestMemory = latestMemory === null ? null : sanitizeMemoryContent(latestMemory);
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

type CaptureSummary = { summary: string; type: string; tags: string[] };
type CaptureChannel = "opencode" | "external";

function isOpencodeCaptureConfigured(): boolean {
  return Boolean(CONFIG.opencodeProvider && CONFIG.opencodeModel);
}

function isExternalCaptureConfigured(): boolean {
  return Boolean(CONFIG.memoryModel && CONFIG.memoryApiUrl);
}

function isChannelConfigured(channel: CaptureChannel): boolean {
  return channel === "opencode" ? isOpencodeCaptureConfigured() : isExternalCaptureConfigured();
}

function buildCaptureSystemPrompt(langName: string): string {
  return `You are a technical memory recorder for a software development project.

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
}

async function resolveCaptureLanguage(userPrompt: string): Promise<string> {
  const { detectLanguage, getLanguageName } = await import("./language-detector.js");
  const targetLang =
    CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
      ? detectLanguage(userPrompt)
      : CONFIG.autoCaptureLanguage;
  return getLanguageName(targetLang);
}

function showFallbackToast(ctx: PluginInput, failedChannel: CaptureChannel, error: unknown): void {
  if (!CONFIG.showErrorToasts) return;
  const errMsg = serializeError(error).error;
  const shortReason = errMsg.length > 100 ? errMsg.substring(0, 100) + "..." : errMsg;
  const label = failedChannel === "opencode" ? "OpenCode provider" : "External API";
  ctx.client?.tui
    .showToast({
      body: {
        title: "Using fallback provider",
        message: `${label} failed (${shortReason}); using configured fallback.`,
        variant: "warning",
        duration: 5000,
      },
    })
    .catch(() => {});
}

async function tryOpencodeSummary(
  context: string,
  userPrompt: string,
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<CaptureSummary> {
  const { ensureProviderConnected, getV2Client, generateStructuredOutput } =
    await loadOpencodeProvider();

  // "inherit" resolves to the model opencode used for the captured prompt
  // (recorded by the chat.params hook). Without a concrete model id, the
  // provider path cannot issue a structured-output request.
  let providerID = CONFIG.opencodeProvider!;
  let modelID = CONFIG.opencodeModel!;
  if (modelID === "inherit") {
    if (!prompt?.providerId || !prompt?.modelId) {
      throw new Error(
        "opencode-mem: opencodeModel is 'inherit' but no session model was recorded for this prompt"
      );
    }
    providerID = prompt.providerId;
    modelID = prompt.modelId;
  }

  // One refresh-on-miss before failing: user-config providers register
  // seconds after plugin setup, so the init snapshot may lag the host.
  if (!(await ensureProviderConnected(providerID))) {
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

  const langName = await resolveCaptureLanguage(userPrompt);
  const systemPrompt = buildCaptureSystemPrompt(langName);

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
    ...(CONFIG.opencodeVariant ? { variant: CONFIG.opencodeVariant } : {}),
    systemPrompt,
    userPrompt: aiPrompt,
    schema,
  });

  return {
    summary: sanitizeMemoryContent(result.summary),
    type: sanitizeMemoryContent(result.type),
    tags: (result.tags || []).map((t: string) => sanitizeMemoryContent(t).toLowerCase().trim()),
  };
}

async function tryExternalSummary(
  context: string,
  sessionID: string,
  userPrompt: string,
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<CaptureSummary> {
  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);
  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);
  const langName = await resolveCaptureLanguage(userPrompt);
  const systemPrompt = buildCaptureSystemPrompt(langName);

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
    summary: sanitizeMemoryContent(result.data.summary),
    type: sanitizeMemoryContent(result.data.type),
    tags: (result.data.tags || []).map((t: string) =>
      sanitizeMemoryContent(t).toLowerCase().trim()
    ),
  };
}

async function persistAutoCaptureMemory(
  ctx: PluginInput,
  sessionID: string,
  prompt: UserPrompt,
  summaryWithTags: string,
  type: string,
  tags: string[],
  containerTag: string,
  metadata: Record<string, unknown>
): Promise<{ success: boolean; id?: string; error?: string; action: string }> {
  if (!CONFIG.updateOnCaptureEnabled) {
    const result = await memoryClient.addMemory(summaryWithTags, containerTag, metadata as any);
    return {
      success: result.success,
      id: result.success ? result.id : undefined,
      error: result.success ? undefined : result.error,
      action: "add",
    };
  }

  const scope = CONFIG.memory.defaultScope === "all-projects" ? "all-projects" : "project";
  // Over-fetch before pin-filtering so pinned hits don't starve the candidate list.
  const searchLimit = Math.min(
    20,
    Math.max(CONFIG.updateOnCaptureMaxCandidates * 3, CONFIG.updateOnCaptureMaxCandidates + 5)
  );
  const search = await memoryClient.searchMemories(summaryWithTags, containerTag, scope, {
    similarityThreshold: CONFIG.updateOnCaptureSimilarityThreshold,
    limit: searchLimit,
  });

  const rawCandidates: UpdateOnCaptureCandidate[] = (search.success ? search.results : []).map(
    (r: any) => ({
      id: String(r.id),
      content: String(r.memory ?? r.content ?? ""),
      similarity: Number(r.similarity ?? 0),
      isPinned: Number(r.isPinned ?? 0) === 1 || r.isPinned === true,
    })
  );
  const candidates = filterUpdateOnCaptureCandidates(rawCandidates);

  if (candidates.length === 0) {
    const result = await memoryClient.addMemory(summaryWithTags, containerTag, metadata as any);
    return {
      success: result.success,
      id: result.success ? result.id : undefined,
      error: result.success ? undefined : result.error,
      action: "add",
    };
  }

  let decision: UpdateOnCaptureDecision;
  try {
    decision = await decideUpdateOnCapture(ctx, sessionID, prompt, summaryWithTags, candidates);
  } catch (error) {
    log("update-on-capture: decision failed, falling back to add", serializeError(error));
    decision = { action: "add" };
  }

  return applyUpdateOnCaptureDecision(
    memoryClient as any,
    decision,
    {
      summary: summaryWithTags,
      type,
      tags,
      containerTag,
      metadata: metadata as any,
    },
    new Set(candidates.map((c) => c.id))
  );
}

async function decideUpdateOnCapture(
  ctx: PluginInput,
  sessionID: string,
  prompt: UserPrompt,
  summary: string,
  candidates: UpdateOnCaptureCandidate[]
): Promise<UpdateOnCaptureDecision> {
  const order = CONFIG.autoCaptureProviderOrder ?? "opencode-first";
  const channels: CaptureChannel[] =
    order === "external-first" ? ["external", "opencode"] : ["opencode", "external"];

  let lastError: unknown;
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i]!;
    if (!isChannelConfigured(channel)) continue;
    try {
      return channel === "opencode"
        ? await tryOpencodeUpdateDecision(summary, candidates, prompt)
        : await tryExternalUpdateDecision(summary, candidates, sessionID, prompt);
    } catch (error) {
      lastError = error;
      const nextConfigured = channels.slice(i + 1).find((c) => isChannelConfigured(c));
      if (!nextConfigured) break;
      showFallbackToast(ctx, channel, error);
    }
  }
  if (lastError) throw lastError;
  return { action: "add" };
}

async function tryOpencodeUpdateDecision(
  summary: string,
  candidates: UpdateOnCaptureCandidate[],
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<UpdateOnCaptureDecision> {
  const { ensureProviderConnected, getV2Client, generateStructuredOutput } =
    await loadOpencodeProvider();

  let providerID = CONFIG.opencodeProvider!;
  let modelID = CONFIG.opencodeModel!;
  if (modelID === "inherit") {
    if (!prompt?.providerId || !prompt?.modelId) {
      throw new Error(
        "opencode-mem: opencodeModel is 'inherit' but no session model was recorded for this prompt"
      );
    }
    providerID = prompt.providerId;
    modelID = prompt.modelId;
  }

  if (!(await ensureProviderConnected(providerID))) {
    throw new Error(`opencode provider '${providerID}' is not connected`);
  }
  const v2Client = getV2Client();
  if (!v2Client) {
    throw new Error("opencode-mem: v2 client not initialized");
  }

  const { z } = await import("zod");
  const schema = z.object({
    action: z.enum(["add", "update", "supersede"]),
    targetId: z.string().optional(),
    content: z.string().optional(),
    reason: z.string().optional(),
  });

  return generateStructuredOutput({
    client: v2Client,
    providerID,
    modelID,
    ...(CONFIG.opencodeVariant ? { variant: CONFIG.opencodeVariant } : {}),
    systemPrompt:
      "You decide whether a new memory should add, update, or supersede similar existing memories. Return only structured JSON.",
    userPrompt: buildUpdateOnCaptureDecisionPrompt(summary, candidates),
    schema,
  });
}

async function tryExternalUpdateDecision(
  summary: string,
  candidates: UpdateOnCaptureCandidate[],
  sessionID: string,
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<UpdateOnCaptureDecision> {
  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);
  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);
  const toolSchema = {
    type: "function" as const,
    function: {
      name: "decide_memory_write",
      description: "Decide how to store a new memory relative to similar existing ones",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "update", "supersede"],
          },
          targetId: { type: "string" },
          content: { type: "string" },
          reason: { type: "string" },
        },
        required: ["action"],
      },
    },
  };

  const captureSessionID = `update-on-capture-${prompt?.id ?? sessionID}-${randomUUID()}`;
  const result = await provider.executeToolCall(
    "You decide whether a new memory should add, update, or supersede similar existing memories.",
    buildUpdateOnCaptureDecisionPrompt(summary, candidates),
    toolSchema,
    captureSessionID
  );

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to decide update-on-capture action");
  }

  const action = result.data.action;
  if (action !== "add" && action !== "update" && action !== "supersede") {
    return { action: "add" };
  }
  return {
    action,
    targetId: typeof result.data.targetId === "string" ? result.data.targetId : undefined,
    content: typeof result.data.content === "string" ? result.data.content : undefined,
    reason: typeof result.data.reason === "string" ? result.data.reason : undefined,
  };
}

async function generateSummary(
  ctx: PluginInput,
  context: string,
  sessionID: string,
  userPrompt: string,
  prompt?: { id?: string; providerId: string | null; modelId: string | null }
): Promise<CaptureSummary | null> {
  const order = CONFIG.autoCaptureProviderOrder ?? "opencode-first";
  const channels: CaptureChannel[] =
    order === "external-first" ? ["external", "opencode"] : ["opencode", "external"];

  if (
    order === "opencode-first" &&
    isOpencodeCaptureConfigured() &&
    isExternalCaptureConfigured()
  ) {
    log("opencodeProvider takes precedence over memoryModel for auto-capture");
  } else if (
    order === "external-first" &&
    isOpencodeCaptureConfigured() &&
    isExternalCaptureConfigured()
  ) {
    log("external API takes precedence over opencodeProvider for auto-capture");
  }

  let lastError: unknown;

  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i]!;
    if (!isChannelConfigured(channel)) continue;

    try {
      return channel === "opencode"
        ? await tryOpencodeSummary(context, userPrompt, prompt)
        : await tryExternalSummary(context, sessionID, userPrompt, prompt);
    } catch (error) {
      lastError = error;
      const nextConfigured = channels.slice(i + 1).find((c) => isChannelConfigured(c));
      if (!nextConfigured) break;

      const fallbackLabel = nextConfigured === "external" ? "external API" : "opencode provider";
      log(`auto-capture: ${channel} provider failed, falling back to ${fallbackLabel}`, {
        ...serializeError(error),
      });
      showFallbackToast(ctx, channel, error);
    }
  }

  if (lastError) throw lastError;
  throw new Error("No auto-capture provider configured");
}
