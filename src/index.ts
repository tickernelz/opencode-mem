import type { Plugin, PluginInput } from "@opencode-ai/plugin";

import {
  createChatMessageHandler,
  createChatParamsHandler,
  isStructuredSummaryPromptMessage,
} from "./hooks/chat-message.js";
import { createMemoryTool } from "./hooks/memory-tool.js";
import { createSessionEventHandler, type IdleTimeoutState } from "./hooks/session-events.js";
import { memoryClient } from "./services/client.js";
import { getTags } from "./services/tags.js";
import { startWebServer, WebServer } from "./services/web-server.js";
import { ensureTursoReady } from "./services/turso/ready.js";
import { tursoConnectionManager } from "./services/turso/connection-manager.js";
import { WebAuth } from "./services/web-auth.js";

import { isConfigured, CONFIG, initConfig } from "./config.js";
import { log } from "./services/logger.js";
import { getHostClientConfig } from "./services/ai/opencode-host-config.js";
import { loadOpencodeProvider } from "./services/ai/opencode-provider-loader.js";

import {
  INTERNAL_CAPTURE_SESSION_TITLE,
  isInternalCaptureSessionTitle,
} from "./services/ai/internal-capture-sessions.js";

export { INTERNAL_CAPTURE_SESSION_TITLE, isInternalCaptureSessionTitle };
export { isStructuredSummaryPromptMessage };

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
  const tags = getTags(directory);
  let webServer: WebServer | null = null;
  const idleTimeout: IdleTimeoutState = { current: null };

  if (!isConfigured()) {
  }

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

  if (!(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
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
  if (CONFIG.webServerEnabled && isConfigured()) {
    try {
      await ensureTursoReady();
      tursoReadyForWeb = true;
    } catch (error) {
      log("Turso ready gate failed before web server start", { error: String(error) });
      if (ctx.client?.tui) {
        ctx.client.tui
          .showToast({
            body: {
              title: "Memory Explorer",
              message: "Database migration failed; web UI not started",
              variant: "error",
              duration: 8000,
            },
          })
          .catch(() => {});
      }
    }
  }

  if (CONFIG.webServerEnabled && tursoReadyForWeb) {
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

        if (webServer.isServerOwner()) {
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
    if (idleTimeout.current) {
      clearTimeout(idleTimeout.current);
      idleTimeout.current = null;
    }
    if (webServer) await webServer.stop();
    if (memoryClient) await memoryClient.close();
  };

  const shutdownHandler = async () => {
    try {
      await cleanupPlugin();
    } catch (error) {
      log("Shutdown error", { error: String(error) });
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  process.on("beforeExit", () => {
    if (!cleanedUp) {
      void cleanupPlugin();
    }
  });
  process.on("exit", () => {
    // Best-effort sync close when the host exits without SIGINT/SIGTERM.
    if (!cleanedUp) {
      try {
        tursoConnectionManager.closeAllSync();
      } catch {
        // ignore — module may already be torn down
      }
    }
  });

  return {
    "chat.message": createChatMessageHandler({ ctx, directory, tags }),
    "chat.params": createChatParamsHandler(),
    tool: {
      memory: createMemoryTool(tags),
    },
    event: createSessionEventHandler({
      ctx,
      directory,
      getWebServer: () => webServer,
      idleTimeout,
    }),
  };
};

