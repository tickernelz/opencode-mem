import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { memoryClient } from "./services/client.js";
import { formatContextForPrompt } from "./services/context.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
import { performAutoCapture } from "./services/auto-capture.js";
import { performUserProfileLearning } from "./services/user-memory-learning.js";
import { userPromptManager } from "./services/user-prompt/user-prompt-manager.js";
import { startWebServer, WebServer } from "./services/web-server.js";

import { isConfigured, CONFIG } from "./config.js";
import { log } from "./services/logger.js";
import type { MemoryType } from "./types/index.js";
import { getLanguageName } from "./services/language-detector.js";

export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  const tags = getTags(directory);
  let webServer: WebServer | null = null;
  let idleTimeout: Timer | null = null;

  if (!isConfigured()) {
  }

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

  if (!(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
    try {
      await memoryClient.warmup();
      (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;
    } catch (error) {
      log("Plugin warmup failed", { error: String(error) });
    }
  }

  if (CONFIG.webServerEnabled) {
    startWebServer({
      port: CONFIG.webServerPort,
      host: CONFIG.webServerHost,
      enabled: CONFIG.webServerEnabled,
    })
      .then((server) => {
        webServer = server;
        const url = webServer.getUrl();

        webServer.setOnTakeoverCallback(async () => {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: "Took over web server ownership",
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
        });

        if (webServer.isServerOwner()) {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI started at ${url}`,
                  variant: "success",
                  duration: 5000,
                },
              })
              .catch(() => {});
          }
        } else {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI available at ${url}`,
                  variant: "info",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
        }
      })
      .catch((error) => {
        log("Web server failed to start", { error: String(error) });

        if (ctx.client?.tui) {
          ctx.client.tui
            .showToast({
              body: {
                title: "Memory Explorer Error",
                message: `Failed to start: ${String(error)}`,
                variant: "error",
                duration: 5000,
              },
            })
            .catch(() => {});
        }
      });
  }

  const shutdownHandler = async () => {
    try {
      if (webServer) {
        await webServer.stop();
      }
      memoryClient.close();
      process.exit(0);
    } catch (error) {
      log("Shutdown error", { error: String(error) });
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  return {
    "chat.message": async (input, output) => {
      if (!isConfigured() || !CONFIG.chatMessage.enabled) return;

      try {
        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        if (textParts.length === 0) return;
        const userMessage = textParts.map((p) => p.text).join("\n");
        if (!userMessage.trim()) return;

        userPromptManager.savePrompt(input.sessionID, output.message.id, directory, userMessage);

        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID },
        });
        const messages = messagesResponse.data || [];

        const hasNonSyntheticUserMessages = messages.some(
          (m) =>
            m.info.role === "user" &&
            !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
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
            id: `memory-context-${Date.now()}`,
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
    },

    tool: {
      memory: tool({
        description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName(CONFIG.autoCaptureLanguage || "en")}). Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for preferences.`,
        args: {
          mode: tool.schema.enum(["add", "search", "profile", "list", "forget", "help"]).optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          type: tool.schema.string().optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(
          args: {
            mode?: "add" | "search" | "profile" | "list" | "forget" | "help";
            content?: string;
            query?: string;
            tags?: string;
            type?: MemoryType;
            memoryId?: string;
            limit?: number;
          },
          toolCtx: { sessionID: string }
        ) {
          if (!isConfigured()) {
            return JSON.stringify({
              success: false,
              error: "Memory system not configured properly.",
            });
          }

          const needsWarmup = !(await memoryClient.isReady());
          if (needsWarmup) {
            return JSON.stringify({ success: false, error: "Memory system is initializing." });
          }

          const mode = args.mode || "help";
          const langName = getLanguageName(CONFIG.autoCaptureLanguage || "en");

          try {
            switch (mode) {
              case "help":
                return JSON.stringify({
                  success: true,
                  message: "Memory System Usage Guide",
                  commands: [
                    {
                      command: "add",
                      description: `Store new memory (MATCH USER LANGUAGE: ${langName})`,
                      args: ["content", "type?", "tags?"],
                    },
                    {
                      command: "search",
                      description: `Search memories via keywords (MATCH USER LANGUAGE: ${langName})`,
                      args: ["query"],
                    },
                    { command: "profile", description: "View user profile", args: [] },
                    { command: "list", description: "List recent memories", args: ["limit?"] },
                    { command: "forget", description: "Remove memory", args: ["memoryId"] },
                  ],
                  tagGuidance: "Use technical keywords for search. Tags rank highest.",
                });

              case "add":
                if (!args.content)
                  return JSON.stringify({ success: false, error: "content required" });
                const sanitizedContent = stripPrivateContent(args.content);
                if (isFullyPrivate(args.content))
                  return JSON.stringify({ success: false, error: "Private content blocked" });
                const tagInfo = tags.project;
                const parsedTags = args.tags
                  ? args.tags.split(",").map((t) => t.trim().toLowerCase())
                  : undefined;
                const result = await memoryClient.addMemory(sanitizedContent, tagInfo.tag, {
                  type: args.type,
                  tags: parsedTags,
                  displayName: tagInfo.displayName,
                  userName: tagInfo.userName,
                  userEmail: tagInfo.userEmail,
                  projectPath: tagInfo.projectPath,
                  projectName: tagInfo.projectName,
                  gitRepoUrl: tagInfo.gitRepoUrl,
                });
                return JSON.stringify({
                  success: result.success,
                  message: `Memory added`,
                  id: result.id,
                  tags: parsedTags,
                });

              case "search":
                if (!args.query) return JSON.stringify({ success: false, error: "query required" });
                const searchRes = await memoryClient.searchMemories(args.query, tags.project.tag);
                if (!searchRes.success)
                  return JSON.stringify({ success: false, error: searchRes.error });
                return formatSearchResults(args.query, searchRes, args.limit);

              case "profile":
                const { userProfileManager } =
                  await import("./services/user-profile/user-profile-manager.js");
                const profile = userProfileManager.getActiveProfile(
                  tags.user.userEmail || "unknown"
                );
                if (!profile) return JSON.stringify({ success: true, profile: null });
                const pData = JSON.parse(profile.profileData);
                return JSON.stringify({
                  success: true,
                  profile: {
                    ...pData,
                    version: profile.version,
                    lastAnalyzed: profile.lastAnalyzedAt,
                  },
                });

              case "list":
                const listRes = await memoryClient.listMemories(tags.project.tag, args.limit || 20);
                if (!listRes.success)
                  return JSON.stringify({ success: false, error: listRes.error });
                return JSON.stringify({
                  success: true,
                  count: listRes.memories?.length,
                  memories: listRes.memories?.map((m: any) => ({
                    id: m.id,
                    content: m.summary,
                    createdAt: m.createdAt,
                  })),
                });

              case "forget":
                if (!args.memoryId)
                  return JSON.stringify({ success: false, error: "memoryId required" });
                const delRes = await memoryClient.deleteMemory(args.memoryId);
                return JSON.stringify({ success: delRes.success, message: `Memory removed` });

              default:
                return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
            }
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      const event = input.event;
      if (event.type === "session.idle") {
        if (!isConfigured()) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        if (idleTimeout) clearTimeout(idleTimeout);

        idleTimeout = setTimeout(async () => {
          try {
            await performAutoCapture(ctx, sessionID, directory);

            if (webServer?.isServerOwner()) {
              await performUserProfileLearning(ctx, directory);
              const { cleanupService } = await import("./services/cleanup-service.js");
              if (await cleanupService.shouldRunCleanup()) await cleanupService.runCleanup();
              const { connectionManager } = await import("./services/sqlite/connection-manager.js");
              connectionManager.checkpointAll();
            }
          } catch (error) {
            log("Idle processing error", { error: String(error) });
          } finally {
            idleTimeout = null;
          }
        }, 10000);
      }

      if (event.type === "session.compacted") {
        if (!isConfigured() || !CONFIG.compaction.enabled) return;

        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        try {
          const tags = getTags(directory);

          const memoriesResult = await memoryClient.searchMemoriesBySessionID(
            sessionID,
            tags.project.tag,
            CONFIG.compaction.memoryLimit
          );

          if (!memoriesResult.success || memoriesResult.results.length === 0) {
            return;
          }

          const memoryContext = formatMemoriesForCompaction(memoriesResult.results);

          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: memoryContext }],
              noReply: true,
            },
          });

          if (ctx.client?.tui) {
            await ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Restored",
                  message: `${memoriesResult.results.length} memories injected after compaction`,
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }

          log("Compaction memory injected", {
            sessionID,
            count: memoriesResult.results.length,
          });
        } catch (error) {
          log("Compaction handler error", { error: String(error) });
        }
      }
    },
  };
};

function formatSearchResults(query: string, results: any, limit?: number): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r: any) => ({
      id: r.id,
      content: r.memory || r.chunk,
      similarity: Math.round(r.similarity * 100),
    })),
  });
}

function formatMemoriesForCompaction(memories: any[]): string {
  let output = `## Restored Session Memory\n\n`;

  memories.forEach((m, i) => {
    output += `### Memory ${i + 1}\n`;
    output += `${m.memory}\n\n`;
    if (m.tags && m.tags.length > 0) {
      output += `Tags: ${m.tags.join(", ")}\n\n`;
    }
  });

  return output;
}
