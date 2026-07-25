import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";

import { CONFIG, isConfigured } from "../config.js";
import { memoryClient } from "../services/client.js";
import { formatContextForPrompt } from "../services/context.js";
import { log } from "../services/logger.js";
import type { TagInfo } from "../services/tags.js";
import { userPromptManager } from "../services/user-prompt/user-prompt-manager.js";

export function isStructuredSummaryPromptMessage(userMessage: string): boolean {
  // This is the plugin's own structured-summary or profile-analysis request.
  // OpenCode echoes it through chat.message like a normal user message, but
  // capturing it would create self-referential memories / an infinite learning loop.
  if (userMessage.includes("# User Profile Analysis")) {
    return true;
  }
  return userMessage.includes("Analyze this conversation.") && userMessage.includes('type="skip"');
}

export function createChatMessageHandler(deps: {
  ctx: PluginInput;
  directory: string;
  tags: { user: TagInfo; project: TagInfo };
}) {
  const { ctx, directory, tags } = deps;

  return async (
    input: { sessionID: string },
    output: { message: { id: string }; parts: Part[] }
  ) => {
    if (!isConfigured() || !CONFIG.chatMessage.enabled) return;

    try {
      const textParts = output.parts.filter(
        (p): p is Part & { type: "text"; text: string } => p.type === "text"
      );

      if (textParts.length === 0) return;
      const userMessage = textParts.map((p) => p.text).join("\n");
      if (!userMessage.trim()) return;

      if (isStructuredSummaryPromptMessage(userMessage)) {
        return;
      }

      userPromptManager.savePrompt(input.sessionID, output.message.id, directory, userMessage);

      const messagesResponse = await ctx.client.session.messages({
        path: { id: input.sessionID },
      });
      const messages = messagesResponse.data || [];

      const hasNonSyntheticUserMessages = messages.some(
        (m) =>
          m.info.role === "user" && !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
      );

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const isAfterCompaction = lastMessage?.info?.summary === true;

      const shouldInject =
        CONFIG.chatMessage.injectOn === "always" ||
        !hasNonSyntheticUserMessages ||
        (isAfterCompaction &&
          messages.filter(
            (m) =>
              m.info.role === "user" &&
              !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
          ).length === 1);

      if (!shouldInject) return;

      const listResult = await memoryClient.listMemories(
        tags.project.tag,
        CONFIG.chatMessage.maxMemories
      );

      let memories = listResult.success ? listResult.memories : [];

      if (CONFIG.chatMessage.excludeCurrentSession) {
        memories = memories.filter((m: any) => m.metadata?.sessionID !== input.sessionID);
      }

      if (CONFIG.chatMessage.maxAgeDays) {
        const cutoffDate = Date.now() - CONFIG.chatMessage.maxAgeDays * 86400000;
        memories = memories.filter((m: any) => new Date(m.createdAt).getTime() > cutoffDate);
      }

      if (memories.length === 0) return;

      const projectMemories = {
        results: memories.map((m: any) => ({
          similarity: 1.0,
          memory: m.summary,
        })),
        total: memories.length,
        timing: 0,
      };

      const userId = tags.user.userEmail || null;
      const memoryContext = formatContextForPrompt(userId, projectMemories);

      if (memoryContext) {
        const contextPart: Part = {
          id: `prt-memory-context-${Date.now()}`,
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: "text",
          text: memoryContext,
          synthetic: true,
        } as any;
        output.parts.unshift(contextPart);
      }
    } catch (error) {
      log("chat.message: ERROR", { error: String(error) });
      if (ctx.client?.tui && CONFIG.showErrorToasts) {
        await ctx.client.tui
          .showToast({
            body: {
              title: "Memory System Error",
              message: String(error),
              variant: "error",
              duration: 5000,
            },
          })
          .catch(() => {});
      }
    }
  };
}

export function createChatParamsHandler() {
  return async (input: { message: { id: string }; model: { providerID: string; id: string } }) => {
    if (!isConfigured() || CONFIG.opencodeModel !== "inherit") return;

    try {
      userPromptManager.setPromptModel(input.message.id, input.model.providerID, input.model.id);
    } catch (error) {
      log("chat.params: ERROR", { error: String(error) });
    }
  };
}
