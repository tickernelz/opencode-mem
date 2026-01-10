import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { memoryClient } from "./services/client.js";
import { formatContextForPrompt } from "./services/context.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
import { AutoCaptureService, performAutoCapture } from "./services/auto-capture.js";
import { startWebServer, WebServer } from "./services/web-server.js";

import { isConfigured, CONFIG } from "./config.js";
import { log } from "./services/logger.js";
import type { MemoryScope, MemoryType } from "./types/index.js";

const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;

const MEMORY_KEYWORD_PATTERN = new RegExp(`\\b(${CONFIG.keywordPatterns.join("|")})\\b`, "i");

const MEMORY_NUDGE_MESSAGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. You MUST use the \`memory\` tool with \`mode: "add"\` to save this information.

Extract the key information the user wants remembered and save it as a concise, searchable memory.
- Use \`scope: "project"\` for project-specific preferences (e.g., "run lint with tests")
- Use \`scope: "user"\` for cross-project preferences (e.g., "prefers concise responses")
- Choose an appropriate \`type\`: "preference", "project-config", "learned-pattern", etc.

DO NOT skip this step. The user explicitly asked you to remember.`;

function removeCodeBlocks(text: string): string {
  return text.replace(CODE_BLOCK_PATTERN, "").replace(INLINE_CODE_PATTERN, "");
}

function detectMemoryKeyword(text: string): boolean {
  const textWithoutCode = removeCodeBlocks(text);
  return MEMORY_KEYWORD_PATTERN.test(textWithoutCode);
}

export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  const tags = getTags(directory);
  const injectedSessions = new Set<string>();
  const autoCaptureService = new AutoCaptureService();
  let webServer: WebServer | null = null;
  
  log("Plugin loaded", { 
    directory, 
    tags, 
    configured: isConfigured(),
    autoCaptureEnabled: autoCaptureService.isEnabled()
  });

  if (!isConfigured()) {
    log("Plugin disabled - memory system not configured");
  }

  if (CONFIG.webServerEnabled) {
    try {
      webServer = await startWebServer({
        port: CONFIG.webServerPort,
        host: CONFIG.webServerHost,
        enabled: CONFIG.webServerEnabled,
      });
      
      const url = webServer.getUrl();
      log("Web server initialized", { url });
      
      if (ctx.client?.tui) {
        await ctx.client.tui.showToast({
          body: {
            title: "Memory Explorer",
            message: `Web UI at ${url}`,
            variant: "success",
            duration: 5000,
          },
        }).catch(() => {});
      }
    } catch (error) {
      const errorMsg = String(error);
      
      if (errorMsg.includes("already running")) {
        log("Web server already running on another instance");
        
        if (ctx.client?.tui) {
          await ctx.client.tui.showToast({
            body: {
              title: "Memory Explorer",
              message: `Web UI already running at http://${CONFIG.webServerHost}:${CONFIG.webServerPort}`,
              variant: "info",
              duration: 3000,
            },
          }).catch(() => {});
        }
      } else {
        log("Web server failed to start", { error: errorMsg });
        
        if (ctx.client?.tui) {
          await ctx.client.tui.showToast({
            body: {
              title: "Memory Explorer Error",
              message: `Failed to start: ${errorMsg}`,
              variant: "error",
              duration: 5000,
            },
          }).catch(() => {});
        }
      }
    }
  }

  const shutdownHandler = async () => {
    if (webServer) {
      await webServer.stop();
    }
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);
  process.on('exit', shutdownHandler);

  return {
    "chat.message": async (input, output) => {
      if (!isConfigured()) return;

      const start = Date.now();

      try {
        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        if (textParts.length === 0) return;

        const userMessage = textParts.map((p) => p.text).join("\n");

        if (!userMessage.trim()) return;

        if (detectMemoryKeyword(userMessage)) {
          const nudgePart: Part = {
            id: `memory-nudge-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: MEMORY_NUDGE_MESSAGE,
            synthetic: true,
          };
          output.parts.push(nudgePart);
        }

        const isFirstMessage = !injectedSessions.has(input.sessionID);

        if (isFirstMessage) {
          injectedSessions.add(input.sessionID);

          const needsWarmup = !(await memoryClient.isReady());

          if (needsWarmup) {
            if (ctx.client?.tui) {
              await ctx.client.tui.showToast({
                body: {
                  title: "Memory System",
                  message: "Initializing (first time: 30-60s)...",
                  variant: "info",
                  duration: 5000,
                },
              }).catch(() => {});
            }

            try {
              await memoryClient.warmup();

              if (ctx.client?.tui) {
                const autoCaptureStatus = autoCaptureService.isEnabled() 
                  ? "Auto-capture: enabled" 
                  : autoCaptureService.getDisabledReason() || "Auto-capture: disabled";
                
                await ctx.client.tui.showToast({
                  body: {
                    title: "Memory System Ready!",
                    message: autoCaptureStatus,
                    variant: autoCaptureService.isEnabled() ? "success" : "warning",
                    duration: 3000,
                  },
                }).catch(() => {});
              }
            } catch (warmupError) {
              log("Warmup failed", { error: String(warmupError) });
              
              if (ctx.client?.tui) {
                await ctx.client.tui.showToast({
                  body: {
                    title: "Memory System Error",
                    message: `Failed to initialize: ${String(warmupError)}`,
                    variant: "error",
                    duration: 10000,
                  },
                }).catch(() => {});
              }
              
              return;
            }
          }

          const [profileResult, userMemoriesResult, projectMemoriesListResult] = await Promise.all([
            memoryClient.getProfile(tags.user, userMessage),
            memoryClient.searchMemories(userMessage, tags.user),
            memoryClient.listMemories(tags.project, CONFIG.maxProjectMemories),
          ]);

          const profile = profileResult.success ? profileResult : null;
          const userMemories = userMemoriesResult.success ? userMemoriesResult : { results: [] };
          const projectMemoriesList = projectMemoriesListResult.success ? projectMemoriesListResult : { memories: [] };

          const projectMemories = {
            results: (projectMemoriesList.memories || []).map((m: any) => ({
              id: m.id,
              memory: m.summary,
              similarity: 1,
              title: m.title,
              metadata: m.metadata,
            })),
            total: projectMemoriesList.memories?.length || 0,
            timing: 0,
          };

          const memoryContext = formatContextForPrompt(
            profile,
            userMemories,
            projectMemories
          );

          if (memoryContext) {
            const contextPart: Part = {
              id: `memory-context-${Date.now()}`,
              sessionID: input.sessionID,
              messageID: output.message.id,
              type: "text",
              text: memoryContext,
              synthetic: true,
            };

            output.parts.unshift(contextPart);
          }
        }

      } catch (error) {
        log("chat.message: ERROR", { error: String(error) });
        
        if (ctx.client?.tui) {
          await ctx.client.tui.showToast({
            body: {
              title: "Memory System Error",
              message: String(error),
              variant: "error",
              duration: 5000,
            },
          }).catch(() => {});
        }
      }
    },

    tool: {
      memory: tool({
        description:
          "Manage and query the local persistent memory system. Use 'search' to find relevant memories, 'add' to store new knowledge, 'profile' to view user profile, 'list' to see recent memories, 'forget' to remove a memory.",
        args: {
          mode: tool.schema
            .enum(["add", "search", "profile", "list", "forget", "help", "capture-now", "auto-capture-toggle", "auto-capture-stats"])
            .optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          type: tool.schema.string().optional(),
          scope: tool.schema.enum(["user", "project"]).optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
        },
        async execute(args: {
          mode?: string;
          content?: string;
          query?: string;
          type?: MemoryType;
          scope?: MemoryScope;
          memoryId?: string;
          limit?: number;
        }, toolCtx: { sessionID: string }) {
          if (!isConfigured()) {
            return JSON.stringify({
              success: false,
              error: "Memory system not configured properly.",
            });
          }

          const needsWarmup = !(await memoryClient.isReady());
          if (needsWarmup) {
            return JSON.stringify({
              success: false,
              error: "Memory system is initializing. Please wait a moment and try again.",
            });
          }

          const mode = args.mode || "help";

          try {
            switch (mode) {
              case "help": {
                return JSON.stringify({
                  success: true,
                  message: "Memory System Usage Guide",
                  commands: [
                    {
                      command: "add",
                      description: "Store a new memory",
                      args: ["content", "type?", "scope?"],
                    },
                    {
                      command: "search",
                      description: "Search memories",
                      args: ["query", "scope?"],
                    },
                    {
                      command: "profile",
                      description: "View user profile",
                      args: ["query?"],
                    },
                    {
                      command: "list",
                      description: "List recent memories",
                      args: ["scope?", "limit?"],
                    },
                    {
                      command: "forget",
                      description: "Remove a memory",
                      args: ["memoryId", "scope?"],
                    },
                    {
                      command: "capture-now",
                      description: "Manually trigger memory capture for current session",
                      args: [],
                    },
                    {
                      command: "auto-capture-toggle",
                      description: "Enable/disable automatic memory capture",
                      args: [],
                    },
                    {
                      command: "auto-capture-stats",
                      description: "View auto-capture statistics for current session",
                      args: [],
                    },
                  ],
                  scopes: {
                    user: "Cross-project user behaviors, preferences, patterns, requests",
                    project: "Project-specific knowledge, decisions, architecture, context",
                  },
                  typeGuidance: "Choose appropriate type: preference, architecture, workflow, bug-fix, configuration, pattern, request, context, etc. Be specific and descriptive with categories.",
                });
              }

              case "add": {
                if (!args.content) {
                  return JSON.stringify({
                    success: false,
                    error: "content parameter is required for add mode",
                  });
                }

                const sanitizedContent = stripPrivateContent(args.content);
                if (isFullyPrivate(args.content)) {
                  return JSON.stringify({
                    success: false,
                    error: "Cannot store fully private content",
                  });
                }

                const scope = args.scope || "project";
                const containerTag =
                  scope === "user" ? tags.user : tags.project;

                const result = await memoryClient.addMemory(
                  sanitizedContent,
                  containerTag,
                  { type: args.type }
                );

                if (!result.success) {
                  return JSON.stringify({
                    success: false,
                    error: result.error || "Failed to add memory",
                  });
                }

                return JSON.stringify({
                  success: true,
                  message: `Memory added to ${scope} scope`,
                  id: result.id,
                  scope,
                  type: args.type,
                });
              }

              case "search": {
                if (!args.query) {
                  return JSON.stringify({
                    success: false,
                    error: "query parameter is required for search mode",
                  });
                }

                const scope = args.scope;

                if (scope === "user") {
                  const result = await memoryClient.searchMemories(
                    args.query,
                    tags.user
                  );
                  if (!result.success) {
                    return JSON.stringify({
                      success: false,
                      error: result.error || "Failed to search memories",
                    });
                  }
                  return formatSearchResults(args.query, scope, result, args.limit);
                }

                if (scope === "project") {
                  const result = await memoryClient.searchMemories(
                    args.query,
                    tags.project
                  );
                  if (!result.success) {
                    return JSON.stringify({
                      success: false,
                      error: result.error || "Failed to search memories",
                    });
                  }
                  return formatSearchResults(args.query, scope, result, args.limit);
                }

                const [userResult, projectResult] = await Promise.all([
                  memoryClient.searchMemories(args.query, tags.user),
                  memoryClient.searchMemories(args.query, tags.project),
                ]);

                if (!userResult.success || !projectResult.success) {
                  return JSON.stringify({
                    success: false,
                    error: userResult.error || projectResult.error || "Failed to search memories",
                  });
                }

                const combined = [
                  ...(userResult.results || []).map((r: any) => ({
                    ...r,
                    scope: "user" as const,
                  })),
                  ...(projectResult.results || []).map((r: any) => ({
                    ...r,
                    scope: "project" as const,
                  })),
                ].sort((a, b) => b.similarity - a.similarity);

                return JSON.stringify({
                  success: true,
                  query: args.query,
                  count: combined.length,
                  results: combined.slice(0, args.limit || 10).map((r) => ({
                    id: r.id,
                    content: r.memory || r.chunk,
                    similarity: Math.round(r.similarity * 100),
                    scope: r.scope,
                  })),
                });
              }

              case "profile": {
                const result = await memoryClient.getProfile(
                  tags.user,
                  args.query
                );

                if (!result.success) {
                  return JSON.stringify({
                    success: false,
                    error: result.error || "Failed to fetch profile",
                  });
                }

                return JSON.stringify({
                  success: true,
                  profile: {
                    static: result.profile?.static || [],
                    dynamic: result.profile?.dynamic || [],
                  },
                });
              }

              case "list": {
                const scope = args.scope || "project";
                const limit = args.limit || 20;
                const containerTag =
                  scope === "user" ? tags.user : tags.project;

                const result = await memoryClient.listMemories(
                  containerTag,
                  limit
                );

                if (!result.success) {
                  return JSON.stringify({
                    success: false,
                    error: result.error || "Failed to list memories",
                  });
                }

                const memories = result.memories || [];
                return JSON.stringify({
                  success: true,
                  scope,
                  count: memories.length,
                  memories: memories.map((m: any) => ({
                    id: m.id,
                    content: m.summary,
                    createdAt: m.createdAt,
                    metadata: m.metadata,
                  })),
                });
              }

              case "forget": {
                if (!args.memoryId) {
                  return JSON.stringify({
                    success: false,
                    error: "memoryId parameter is required for forget mode",
                  });
                }

                const scope = args.scope || "project";

                const result = await memoryClient.deleteMemory(
                  args.memoryId
                );

                if (!result.success) {
                  return JSON.stringify({
                    success: false,
                    error: result.error || "Failed to delete memory",
                  });
                }

                return JSON.stringify({
                  success: true,
                  message: `Memory ${args.memoryId} removed from ${scope} scope`,
                });
              }

              case "capture-now": {
                await performAutoCapture(ctx, autoCaptureService, toolCtx.sessionID, directory);
                return JSON.stringify({
                  success: true,
                  message: "Manual capture triggered",
                });
              }

              case "auto-capture-toggle": {
                const enabled = autoCaptureService.toggle();
                return JSON.stringify({
                  success: true,
                  message: `Auto-capture ${enabled ? "enabled" : "disabled"}`,
                  enabled,
                });
              }

              case "auto-capture-stats": {
                const stats = autoCaptureService.getStats(toolCtx.sessionID);
                if (!stats) {
                  return JSON.stringify({
                    success: true,
                    message: "No capture data for this session",
                  });
                }
                return JSON.stringify({
                  success: true,
                  stats: {
                    lastCaptureTokens: stats.lastCaptureTokens,
                    minutesSinceCapture: Math.floor(stats.timeSinceCapture / 60000),
                    tokenThreshold: CONFIG.autoCaptureTokenThreshold,
                    minTokens: CONFIG.autoCaptureMinTokens,
                    enabled: autoCaptureService.isEnabled(),
                  },
                });
              }

              default:
                return JSON.stringify({
                  success: false,
                  error: `Unknown mode: ${mode}`,
                });
            }
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      if (!autoCaptureService.isEnabled()) return;

      const event = input.event;
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "message.updated") {
        const info = props?.info as any;
        if (!info) return;

        const sessionID = info.sessionID;
        if (!sessionID) return;

        if (info.role !== "assistant" || !info.finish) return;

        const tokens = info.tokens;
        if (!tokens) return;

        const totalUsed = tokens.input + tokens.cache.read + tokens.output;

        const shouldCapture = autoCaptureService.checkTokenThreshold(sessionID, totalUsed);

        if (shouldCapture) {
          performAutoCapture(ctx, autoCaptureService, sessionID, directory).catch(
            (err) => log("Auto-capture failed", { error: String(err) })
          );
        }
      }

      if (event.type === "session.deleted" && props?.sessionID) {
        autoCaptureService.cleanup(props.sessionID as string);
      }
    },
  };
};

function formatSearchResults(
  query: string,
  scope: string | undefined,
  results: { results?: Array<{ id: string; memory?: string; chunk?: string; similarity: number }> },
  limit?: number
): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    scope,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r) => ({
      id: r.id,
      content: r.memory || r.chunk,
      similarity: Math.round(r.similarity * 100),
    })),
  });
}
