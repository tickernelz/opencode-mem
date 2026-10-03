import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { memoryClient } from "../../memory/client.js";
import { formatContextForPrompt } from "../../memory/context.js";
import { getTags } from "../../memory/tags.js";
import { awaitCaptureDrain, performAutoCapture } from "../../memory/auto-capture.js";
import { performUserProfileLearning } from "../../memory/user-memory-learning.js";
import { userPromptManager } from "../../memory/user-prompt/user-prompt-manager.js";
import { startWebServer, WebServer } from "../../runtime/http/web-server.js";
import { ensureTursoReady } from "../../storage/turso/ready.js";
import { tursoConnectionManager } from "../../storage/turso/connection-manager.js";
import { WebAuth } from "../../runtime/http/web-auth.js";
import { executeMemoryTool, type MemoryToolArgs } from "../../memory/tool/index.js";
import { writeRuntimeInfo, clearRuntimeInfo } from "../../runtime/http/runtime-info.js";
import { findHealthyRuntimeBaseUrl, ensureSharedRuntimeClient } from "../../runtime/client.js";
import { setSharedRuntimeBridge } from "../../runtime/bridge.js";
import { readRuntimeInfo } from "../../runtime/http/runtime-info.js";

import { isConfigured, CONFIG, initConfig } from "../../config.js";
import { log } from "../../infra/logger.js";
import { getLanguageName } from "../../infra/language-detector.js";
import { filterInjectedParts } from "../../memory/injected-prompt-filter.js";
import { getHostClientConfig } from "../../ai/opencode-host-config.js";
import { loadOpencodeProvider } from "../../ai/opencode-provider-loader.js";
import {
  isInternalStructuredSession,
  noteStructuredOutputStep,
  STRUCTURED_OUTPUT_AGENT,
  STRUCTURED_OUTPUT_MAX_STEPS,
  STRUCTURED_OUTPUT_TOOLS,
} from "../../ai/opencode-provider.js";

import {
  INTERNAL_CAPTURE_SESSION_TITLE,
  isInternalCaptureSessionTitle,
  isTrackedInternalCaptureSession,
} from "../../ai/internal-capture-sessions.js";

export { INTERNAL_CAPTURE_SESSION_TITLE, isInternalCaptureSessionTitle };

export function isStructuredSummaryPromptMessage(userMessage: string): boolean {
  // This is the plugin's own structured-summary or profile-analysis request.
  // OpenCode echoes it through chat.message like a normal user message, but
  // capturing it would create self-referential memories / an infinite learning loop.
  if (userMessage.includes("# User Profile Analysis")) {
    return true;
  }
  return userMessage.includes("Analyze this conversation.") && userMessage.includes('type="skip"');
}

function extractSessionTitle(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as {
    data?: { title?: string };
    title?: string;
  };
  return obj.data?.title ?? obj.title;
}

function unwrapSdkData<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as { data?: T };
  return (obj.data ?? response) as T;
}

/**
 * Resolve the session's active agent so compaction memory injection does not
 * reset OpenCode to the stock "general-purpose" fallback (issue #236).
 *
 * Preference order:
 * 1. session.get().agent (v2 hosts)
 * 2. Latest non-compaction user message agent
 * 3. Latest non-compaction / non-summary assistant mode (v1) or agent (v2)
 */
export async function resolveSessionAgent(
  client: unknown,
  sessionID: string
): Promise<string | undefined> {
  const sessionClient = (
    client as {
      session?: {
        get?: (args: unknown) => Promise<unknown>;
        messages?: (args: unknown) => Promise<unknown>;
      };
    }
  )?.session;

  if (typeof sessionClient?.get === "function") {
    try {
      const session = unwrapSdkData<{ agent?: string }>(
        await sessionClient.get({ path: { id: sessionID } })
      );
      if (typeof session?.agent === "string" && session.agent.trim()) {
        return session.agent.trim();
      }
    } catch (error) {
      log("resolveSessionAgent: session.get failed", { sessionID, error: String(error) });
    }
  }

  if (typeof sessionClient?.messages !== "function") {
    return undefined;
  }

  try {
    const messages = unwrapSdkData<
      Array<{
        info?: {
          role?: string;
          agent?: string;
          mode?: string;
          summary?: boolean;
        };
      }>
    >(await sessionClient.messages({ path: { id: sessionID } }));

    if (!Array.isArray(messages)) return undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (!info) continue;

      if (info.role === "user") {
        if (typeof info.agent === "string" && info.agent.trim()) {
          return info.agent.trim();
        }
        continue;
      }

      if (info.role === "assistant") {
        if (info.summary === true || info.mode === "compaction") continue;
        const agent =
          (typeof info.agent === "string" && info.agent.trim()) ||
          (typeof info.mode === "string" && info.mode.trim()) ||
          undefined;
        if (agent) return agent;
      }
    }
  } catch (error) {
    log("resolveSessionAgent: session.messages failed", { sessionID, error: String(error) });
  }

  return undefined;
}

/**
 * Resolve the session's current model (the server-side `session.model`, written by the most
 * recent real user message and left untouched by compaction). Compaction memory injection must
 * pass it explicitly: OpenCode resolves `input.model ?? agent.model ?? session.model`, so when the
 * active agent declares its own model the injected message would otherwise switch the session to
 * that agent's default model and variant.
 */
export async function resolveSessionModel(
  client: unknown,
  sessionID: string
): Promise<{ model: { providerID: string; modelID: string }; variant?: string } | undefined> {
  const sessionClient = (client as { session?: { get?: (args: unknown) => Promise<unknown> } })
    ?.session;
  if (typeof sessionClient?.get !== "function") return undefined;

  try {
    const session = unwrapSdkData<{
      model?: { providerID?: string; id?: string; variant?: string };
    }>(await sessionClient.get({ path: { id: sessionID } }));
    const model = session?.model;
    if (typeof model?.providerID !== "string" || typeof model?.id !== "string") return undefined;
    const variant =
      typeof model.variant === "string" && model.variant && model.variant !== "default"
        ? model.variant
        : undefined;
    return {
      model: { providerID: model.providerID, modelID: model.id },
      ...(variant ? { variant } : {}),
    };
  } catch (error) {
    log("resolveSessionModel: session.get failed", { sessionID, error: String(error) });
    return undefined;
  }
}

async function isInternalCaptureSession(client: unknown, sessionID: string): Promise<boolean> {
  // Fast path: sessions we created ourselves (survives brief post-delete window).
  if (isTrackedInternalCaptureSession(sessionID)) {
    return true;
  }

  const sessionClient = (
    client as {
      session?: {
        get?: (args: unknown) => Promise<unknown>;
      };
    }
  )?.session;

  // Plugin host client uses path-based args (same as session.messages).
  if (typeof sessionClient?.get === "function") {
    try {
      const response = await sessionClient.get({ path: { id: sessionID } });
      const title = extractSessionTitle(response);
      if (isInternalCaptureSessionTitle(title)) {
        return true;
      }
      log("internal capture session check via session.get", {
        sessionID,
        title: title ?? null,
        matched: false,
      });
    } catch (error) {
      log("internal capture session check via session.get failed", {
        sessionID,
        error: String(error),
      });
    }
  } else {
    log("internal capture session check: session.get unavailable", { sessionID });
  }

  return false;
}

/** Least-privilege agent used only by internal structured-output sessions (issue #189). */
export function applyStructuredOutputAgentConfig(cfg: { agent?: Record<string, unknown> }): void {
  cfg.agent = {
    ...cfg.agent,
    [STRUCTURED_OUTPUT_AGENT]: {
      description: "Internal least-privilege agent for opencode-mem structured output",
      mode: "subagent",
      // OpenCode reads `steps` at runtime; SDK AgentConfig also documents maxSteps.
      steps: STRUCTURED_OUTPUT_MAX_STEPS,
      maxSteps: STRUCTURED_OUTPUT_MAX_STEPS,
      tools: STRUCTURED_OUTPUT_TOOLS,
      permission: {
        "*": "deny",
        StructuredOutput: "allow",
      },
      // OpenCode maps format:json_schema to tool_choice:"required". Thinking-enabled
      // models (e.g. DeepSeek V4) reject that combo — disable thinking for this
      // internal agent so auto-capture / profile learning can force StructuredOutput (#253).
      options: {
        thinking: { type: "disabled" },
      },
    },
  };
}

/**
 * Force-disable thinking on structured-output chat.params after OpenCode merges
 * model/agent/variant options. A user reasoning variant merges last and can
 * otherwise re-enable thinking (#253).
 */
export function applyStructuredOutputChatParams(
  input: { agent?: unknown },
  output: { options?: Record<string, unknown> } | undefined
): void {
  if (!output || input.agent !== STRUCTURED_OUTPUT_AGENT) return;
  output.options = {
    ...(output.options ?? {}),
    thinking: { type: "disabled" },
  };
}

export async function configureOpencodeHostTransport(ctx: {
  readonly client: unknown;
  readonly serverUrl?: string | URL;
}): Promise<void> {
  const { createV2Client, resetHostFetch, setHostFetch, setV2Client } =
    await loadOpencodeProvider();
  resetHostFetch();
  const hostConfig = getHostClientConfig(ctx);
  if (hostConfig.fetch) {
    setHostFetch(hostConfig.fetch);
  } else {
    log("OpenCode host fetch unavailable; falling back to global fetch", {
      clientKeys: hostConfig.clientKeys,
      sdkConfigCount: hostConfig.sdkConfigCount,
    });
  }

  const serverUrl = hostConfig.baseUrl ?? ctx.serverUrl;
  if (serverUrl) {
    setV2Client(
      createV2Client(serverUrl, {
        fetch: hostConfig.fetch,
        headers: hostConfig.headers,
      })
    );
  }
}

function logAutoCaptureProviderStatus(): void {
  if (!CONFIG.autoCaptureEnabled || CONFIG.autoCaptureProviderStatus.ready) return;

  log(
    `Auto-capture disabled by configuration. Issues: ${CONFIG.autoCaptureProviderStatus.issues.join("; ")}.`
  );
}

export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  initConfig(directory);
  logAutoCaptureProviderStatus();
  const { startAutoUpdate } = await import("../../infra/auto-update.js");
  startAutoUpdate(ctx, CONFIG.autoUpdate);
  const tags = getTags(directory);
  let webServer: WebServer | null = null;
  // One idle debounce timer per session: a new idle for the same session resets
  // its own timer, but must never cancel another session's pending capture
  // (starving a finished session's summary forever once no further idle
  // events arrive).
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Aborted on plugin dispose: queued-but-not-started auto-capture jobs are
  // skipped; in-flight work keeps its original (uncancellable) semantics.
  const pluginLifetime = new AbortController();

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

  let attachedSharedRuntime = false;
  if (CONFIG.preferSharedRuntime !== false && isConfigured()) {
    try {
      const healthy = await findHealthyRuntimeBaseUrl();
      const runtimeInfo = readRuntimeInfo();
      const foreignOwner = healthy && (!runtimeInfo?.pid || runtimeInfo.pid !== process.pid);
      if (healthy && foreignOwner) {
        const client = await ensureSharedRuntimeClient(directory);
        // ensureSharedRuntimeClient may auto-start serve; re-check we are attaching
        // to a different process when possible.
        setSharedRuntimeBridge(client, client.baseUrl);
        attachedSharedRuntime = true;
        log("OpenCode attached to shared memory runtime", { url: client.baseUrl });
        if (ctx.client?.tui) {
          ctx.client.tui
            .showToast({
              body: {
                title: "Memory",
                message: `Using shared runtime at ${client.baseUrl}`,
                variant: "info",
                duration: 4000,
              },
            })
            .catch(() => {});
        }
      }
    } catch (error) {
      log("Shared runtime attach failed; falling back to in-process", {
        error: String(error),
      });
      setSharedRuntimeBridge(null);
      attachedSharedRuntime = false;
    }
  }

  if (!attachedSharedRuntime && !(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
    // Fire-and-forget: DB ready + embedding model must not block plugin init.
    (async () => {
      try {
        await memoryClient.warmup();
        (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;
      } catch (error) {
        log("Plugin memory warmup failed", { error: String(error) });
      }
    })();
  }

  await configureOpencodeHostTransport(ctx);

  (async () => {
    try {
      const providerResult = await ctx.client.provider.list();
      if (providerResult.data?.connected) {
        const { setConnectedProviders } = await loadOpencodeProvider();
        setConnectedProviders(providerResult.data.connected);
        log("opencode providers connected", {
          list: providerResult.data.connected,
          configured: CONFIG.opencodeProvider || "(not set)",
        });
      } else {
        log("opencode provider list empty or failed", {
          data: JSON.stringify(providerResult.data).substring(0, 100),
        });
      }
    } catch (error) {
      log("Failed to initialize opencode provider state", { error: String(error) });
    }
  })();

  let tursoReadyForWeb = !isConfigured();
  if (!attachedSharedRuntime && CONFIG.webServerEnabled && isConfigured()) {
    try {
      await ensureTursoReady();
      tursoReadyForWeb = true;
    } catch (error) {
      log("Turso ready gate failed before web server start", { error: String(error) });
      if (ctx.client?.tui) {
        const { isTursoMultiProcessLockError } =
          await import("../../storage/turso/connection-manager.js");
        const lockHeld = isTursoMultiProcessLockError(error);
        ctx.client.tui
          .showToast({
            body: {
              title: "Memory Explorer",
              message: lockHeld
                ? process.platform === "win32"
                  ? "Memory DB locked by another OpenCode session (Windows is single-owner)"
                  : "Memory DB locked by another session — close it or restart all OpenCode windows"
                : "Database migration failed; web UI not started",
              variant: "error",
              duration: 8000,
            },
          })
          .catch(() => {});
      }
    }
  }

  if (!attachedSharedRuntime && CONFIG.webServerEnabled && tursoReadyForWeb) {
    const webAuth = new WebAuth({
      password: CONFIG.webServerAuthPassword,
      username: CONFIG.webServerAuthUsername,
    });
    startWebServer({
      port: CONFIG.webServerPort,
      host: CONFIG.webServerHost,
      enabled: CONFIG.webServerEnabled,
      auth: webAuth,
      apiToken: CONFIG.webServerApiToken,
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

        webServer.setOnPortsExhaustedCallback(() => {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI unavailable: ports ${CONFIG.webServerPort}-${CONFIG.webServerPort + 10} are held by non-responsive processes`,
                  variant: "error",
                  duration: 5000,
                },
              })
              .catch(() => {});
          }
        });

        if (webServer.isServerOwner()) {
          try {
            const parsed = new URL(url);
            const host = parsed.hostname === "0.0.0.0" ? "127.0.0.1" : parsed.hostname;
            const port = Number(parsed.port || CONFIG.webServerPort);
            writeRuntimeInfo({
              host,
              port,
              pid: process.pid,
              url: `http://${host}:${port}`,
              startedAt: Date.now(),
            });
          } catch {
            // best-effort runtime discovery for MCP
          }
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: webAuth.isEnabled()
                    ? `Web UI started at ${url} (auth required)`
                    : `Web UI started at ${url}`,
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

  let cleanedUp = false;
  const cleanupPlugin = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    pluginLifetime.abort();
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    // Drain in-flight (and already-queued-before-abort) captures before
    // closing storage: abort only skips not-yet-started jobs.
    await awaitCaptureDrain();
    if (webServer) await webServer.stop();
    clearRuntimeInfo(process.pid);
    const wasShared = attachedSharedRuntime;
    setSharedRuntimeBridge(null);
    if (!wasShared && memoryClient) await memoryClient.close();
  };

  const shutdownHandler = async () => {
    try {
      await cleanupPlugin();
    } catch (error) {
      log("Shutdown error", { error: String(error) });
      process.exitCode = 1;
    }
  };

  const beforeExitHandler = () => {
    if (!cleanedUp) {
      void cleanupPlugin();
    }
  };
  const exitHandler = () => {
    // Best-effort sync close when the host exits without SIGINT/SIGTERM.
    if (!cleanedUp) {
      try {
        tursoConnectionManager.closeAllSync();
      } catch {
        // ignore — module may already be torn down
      }
    }
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  process.on("beforeExit", beforeExitHandler);
  process.on("exit", exitHandler);

  const disposePlugin = async () => {
    process.off("SIGINT", shutdownHandler);
    process.off("SIGTERM", shutdownHandler);
    process.off("beforeExit", beforeExitHandler);
    process.off("exit", exitHandler);
    await cleanupPlugin();
  };

  // Capture remains tied to authored prompts. V2 can rebuild request context
  // independently when its in-memory session cache is lost on host/plugin reload.
  const capturePrompt = async (
    sessionID: string,
    messageID: string,
    parts: Part[]
  ): Promise<boolean> => {
    if (!isConfigured() || !CONFIG.chatMessage.enabled) return false;

    const textParts = parts.filter(
      (p): p is Part & { type: "text"; text: string } => p.type === "text"
    );

    if (textParts.length === 0) return false;

    // Host- and plugin-injected blocks reach this hook through the same
    // parts array as real user input. Recording them would train both
    // auto-capture and profile learning on another plugin's boilerplate.
    const authoredParts = CONFIG.chatMessage.filterInjectedPrompts
      ? filterInjectedParts(textParts, CONFIG.chatMessage.injectionMarkers)
      : textParts;

    if (authoredParts.length === 0) return false;
    const userMessage = authoredParts.map((p) => p.text).join("\n");
    if (!userMessage.trim()) return false;

    if (isStructuredSummaryPromptMessage(userMessage) || isInternalStructuredSession(sessionID)) {
      return false;
    }

    await userPromptManager.savePrompt(sessionID, messageID, directory, userMessage);
    return true;
  };

  const loadMemoryContext = async (sessionID: string): Promise<string> => {
    const listResult = await memoryClient.listMemories(
      tags.project.tag,
      CONFIG.chatMessage.maxMemories
    );

    let memories = listResult.success ? listResult.memories : [];

    if (CONFIG.chatMessage.excludeCurrentSession) {
      memories = memories.filter((m: any) => m.metadata?.sessionID !== sessionID);
    }

    if (CONFIG.chatMessage.maxAgeDays) {
      const cutoffDate = Date.now() - CONFIG.chatMessage.maxAgeDays * 86400000;
      memories = memories.filter((m: any) => new Date(m.createdAt).getTime() > cutoffDate);
    }

    if (memories.length === 0) return "";

    const projectMemories = {
      results: memories.map((m: any) => ({
        similarity: 1.0,
        memory: m.summary,
      })),
      total: memories.length,
      timing: 0,
    };

    const userId = tags.user.userEmail || null;
    return formatContextForPrompt(userId, projectMemories);
  };

  return {
    // V1 ignores this extra hook; the V2 adapter uses it during plugin reload.
    dispose: disposePlugin,
    // Internal V2 bridge; V1 still injects synthetic parts through chat.message.
    memoryContext: {
      enabled: () => isConfigured() && CONFIG.chatMessage.enabled,
      refreshOnPrompt: () => CONFIG.chatMessage.injectOn === "always",
      capturePrompt: async (
        input: { sessionID: string },
        output: { message: { id: string }; parts: Part[] }
      ) => capturePrompt(input.sessionID, output.message.id, output.parts),
      load: async (sessionID: string) => {
        if (
          !isConfigured() ||
          !CONFIG.chatMessage.enabled ||
          isInternalStructuredSession(sessionID) ||
          (await isInternalCaptureSession(ctx.client, sessionID))
        ) {
          return "";
        }
        return loadMemoryContext(sessionID);
      },
    },
    config: async (cfg) => {
      applyStructuredOutputAgentConfig(cfg);
    },

    "chat.message": async (input, output) => {
      if (!isConfigured() || !CONFIG.chatMessage.enabled) return;

      try {
        if (!(await capturePrompt(input.sessionID, output.message.id, output.parts))) return;

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

        const memoryContext = await loadMemoryContext(input.sessionID);

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
    },

    "chat.params": async (input, output) => {
      applyStructuredOutputChatParams(input, output);

      if (!isConfigured() || CONFIG.opencodeModel !== "inherit") return;

      try {
        await userPromptManager.setPromptModel(
          input.message.id,
          input.model.providerID,
          input.model.id
        );
      } catch (error) {
        log("chat.params: ERROR", { error: String(error) });
      }
    },

    tool: {
      memory: tool({
        description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName(CONFIG.autoCaptureLanguage || "en")}). Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for preferences. Use migrate/list-shards/export/import when a project directory moves. Search/list scope: project or all-projects.`,
        args: {
          mode: tool.schema
            .enum([
              "add",
              "search",
              "profile",
              "list",
              "forget",
              "help",
              "migrate",
              "list-shards",
              "export",
              "import",
            ])
            .optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          type: tool.schema.string().optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
          scope: tool.schema.enum(["project", "all-projects"]).optional(),
          fromPath: tool.schema.string().optional(),
          fromHash: tool.schema.string().optional(),
          outputPath: tool.schema.string().optional(),
          inputPath: tool.schema.string().optional(),
          dryRun: tool.schema.boolean().optional(),
          allowLinkedSource: tool.schema.boolean().optional(),
        },
        async execute(args: MemoryToolArgs) {
          return executeMemoryTool(args, {
            directory,
            platformSource: "opencode",
          });
        },
      }),
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      const event = input.event;

      // Client-side step watchdog for internal structured-output sessions (#278).
      // OpenCode's agent.steps soft-cap does not hard-stop json_schema loops when
      // forced StructuredOutput keeps failing (e.g. opencode-claude-auth).
      if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.type === "step-start" && typeof part.sessionID === "string") {
          const { shouldAbort, steps } = noteStructuredOutputStep(part.sessionID);
          if (shouldAbort) {
            log("Aborting structured-output session after step budget", {
              sessionID: part.sessionID,
              steps,
              maxSteps: STRUCTURED_OUTPUT_MAX_STEPS,
            });
            try {
              await ctx.client.session.abort({ path: { id: part.sessionID } });
            } catch (error) {
              log("structured-output step abort failed", {
                sessionID: part.sessionID,
                error: String(error),
              });
            }
          }
        }
        return;
      }

      if (event.type === "session.idle") {
        if (!isConfigured() || !CONFIG.autoCaptureEnabled) return;
        if (cleanedUp) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        // Transient structured-output sessions must not re-trigger capture/learning
        // (that self-schedules an unbounded idle → LLM → idle loop).
        if (await isInternalCaptureSession(ctx.client, sessionID)) {
          log("Skipping idle processing for internal capture session", { sessionID });
          return;
        }

        // The internal-capture check above awaits: dispose may have run while it
        // was in flight. Never arm post-dispose timers.
        if (cleanedUp) return;

        // Same-session idles debounce into one capture; different sessions
        // each keep their own pending timer (see idleTimers comment above).
        const existingTimer = idleTimers.get(sessionID);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(async () => {
          try {
            idleTimers.delete(sessionID);
            await performAutoCapture(ctx, sessionID, directory, {
              signal: pluginLifetime.signal,
            });

            // Prompts are shared across projects, but web-server ownership tracks
            // whoever bound the port first and is never handed over while that
            // process stays reachable. Gating learning on it stalls the queue
            // whenever the owner stops seeing sessions, and disables learning
            // outright when the web server is off. Any active instance may learn;
            // performUserProfileLearning holds a cross-process lock internally.
            if (cleanedUp) return;
            await performUserProfileLearning(ctx, directory);

            // Retention cleanup stays owner-only: it is storage-wide maintenance
            // that has no reason to run once per active instance.
            if (webServer?.isServerOwner()) {
              const { cleanupService } = await import("../../memory/cleanup-service.js");
              if (await cleanupService.shouldRunCleanup()) await cleanupService.runCleanup();
            }
          } catch (error) {
            log("Idle processing error", { error: String(error) });
          } finally {
            // Only drop the entry if it is still ours: a newer idle for this
            // session may have re-armed a fresh timer while we ran.
            if (idleTimers.get(sessionID) === timer) idleTimers.delete(sessionID);
          }
        }, 10000);
        idleTimers.set(sessionID, timer);
        // Dispose may have cleared the map between the cleanedUp check above
        // and this set; never leave an orphan timer armed after cleanup.
        if (cleanedUp) {
          clearTimeout(timer);
          idleTimers.delete(sessionID);
        }
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
          const agent = await resolveSessionAgent(ctx.client, sessionID);
          if (!agent) {
            log(
              "Compaction: skipped memory injection because session agent could not be resolved",
              {
                sessionID,
              }
            );
            return;
          }
          const current = await resolveSessionModel(ctx.client, sessionID);

          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  id: `prt-compaction-${Date.now()}`,
                  type: "text",
                  text: memoryContext,
                  synthetic: true,
                },
              ],
              noReply: true,
              agent,
              ...(current ? { model: current.model } : {}),
              ...(current?.variant ? { variant: current.variant } : {}),
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
            agent: agent ?? null,
            model: current ? `${current.model.providerID}/${current.model.modelID}` : null,
          });
        } catch (error) {
          log("Compaction handler error", { error: String(error) });
        }
      }
    },
  };
};

const EMBEDDED_TAGS_FOOTER_RE = /\n*Tags: ([^\n]*)\s*$/;

function normalizeTagsKey(tags: string[]): string {
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .sort()
    .join("\0");
}

function stripMatchingEmbeddedTagsFooter(memory: string, tags: string[]): string {
  const match = memory.match(EMBEDDED_TAGS_FOOTER_RE);
  if (!match) {
    return memory;
  }

  const footerValue = match[1];
  if (footerValue === undefined) {
    return memory;
  }

  const embeddedTags = footerValue
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  if (normalizeTagsKey(embeddedTags) !== normalizeTagsKey(tags)) {
    return memory;
  }

  return memory.replace(EMBEDDED_TAGS_FOOTER_RE, "");
}

function formatMemoriesForCompaction(memories: any[]): string {
  let output = `## Restored Session Memory\n\n`;

  memories.forEach((m, i) => {
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const body =
      tags.length > 0 ? stripMatchingEmbeddedTagsFooter(m.memory ?? "", tags) : (m.memory ?? "");

    output += `### Memory ${i + 1}\n`;
    output += `${body}\n\n`;
    if (tags.length > 0) {
      output += `Tags: ${tags.join(", ")}\n\n`;
    }
  });

  return output;
}
