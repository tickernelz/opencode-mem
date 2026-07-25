import type { PluginInput } from "@opencode-ai/plugin";

import { CONFIG, isConfigured } from "../config.js";
import { performAutoCapture } from "../services/auto-capture.js";
import { memoryClient } from "../services/client.js";
import { log } from "../services/logger.js";
import { getTags } from "../services/tags.js";
import { performUserProfileLearning } from "../services/user-memory-learning.js";
import type { WebServer } from "../services/web-server.js";

import {
  isInternalCaptureSessionTitle,
  isTrackedInternalCaptureSession,
} from "../services/ai/internal-capture-sessions.js";

function extractSessionTitle(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const obj = response as {
    data?: { title?: string };
    title?: string;
  };
  return obj.data?.title ?? obj.title;
}

async function isInternalCaptureSession(client: unknown, sessionID: string): Promise<boolean> {
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


export type IdleTimeoutState = {
  current: Timer | null;
};

export function formatMemoriesForCompaction(memories: any[]): string {
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

export function createSessionEventHandler(deps: {
  ctx: PluginInput;
  directory: string;
  getWebServer: () => WebServer | null;
  idleTimeout: IdleTimeoutState;
}) {
  const { ctx, directory, getWebServer, idleTimeout } = deps;

  return async (input: { event: { type: string; properties?: any } }) => {
    const event = input.event;
    if (event.type === "session.idle") {
      if (!isConfigured() || !CONFIG.autoCaptureEnabled) return;
      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;

      if (await isInternalCaptureSession(ctx.client, sessionID)) {
        log("Skipping idle processing for internal capture session", { sessionID });
        return;
      }

      if (idleTimeout.current) clearTimeout(idleTimeout.current);

      idleTimeout.current = setTimeout(async () => {
        try {
          await performAutoCapture(ctx, sessionID, directory);

          const webServer = getWebServer();
          if (webServer?.isServerOwner()) {
            await performUserProfileLearning(ctx, directory);
            const { cleanupService } = await import("../services/cleanup-service.js");
            if (await cleanupService.shouldRunCleanup()) await cleanupService.runCleanup();
          }
        } catch (error) {
          log("Idle processing error", { error: String(error) });
        } finally {
          idleTimeout.current = null;
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
            parts: [{ id: `prt-compaction-${Date.now()}`, type: "text", text: memoryContext }],
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
  };
}
