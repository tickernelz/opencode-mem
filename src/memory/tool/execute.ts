import { CONFIG, isConfigured } from "../../config.js";
import { memoryClient } from "../client.js";
import { getLanguageName } from "../../infra/language-detector.js";
import { stripPrivateContent, isFullyPrivate } from "../../infra/privacy.js";
import { getTags } from "../tags.js";
import { resolvePlatformSource } from "../../shared/platform-source.js";
import { getSharedRuntimeBridge } from "../../runtime/bridge.js";
import { formatSearchResults, type MemoryToolArgs, type MemoryToolContext } from "./types.js";

/**
 * Shared memory tool implementation used by the OpenCode plugin, standalone
 * HTTP MCP endpoints, and (indirectly) the MCP stdio server.
 *
 * When a shared runtime bridge is active (OpenCode attached to `serve`), common
 * modes are proxied over `/api/runtime/tool` so Turso/embeddings stay
 * single-owner and response shapes match in-process plugin results.
 * MCP progressive compression stays on `/api/mcp/*` only.
 */
export async function executeMemoryTool(
  args: MemoryToolArgs,
  ctx: MemoryToolContext
): Promise<string> {
  if (!isConfigured()) {
    return JSON.stringify({
      success: false,
      error: "Memory system not configured properly.",
    });
  }

  const mode = args.mode || "help";
  const bridge = getSharedRuntimeBridge();
  if (bridge && ["add", "search", "list", "forget", "profile"].includes(mode)) {
    return executeMemoryToolViaBridge(args, ctx, bridge);
  }

  return executeMemoryToolLocal(args, ctx);
}

async function executeMemoryToolViaBridge(
  args: MemoryToolArgs,
  ctx: MemoryToolContext,
  bridge: NonNullable<ReturnType<typeof getSharedRuntimeBridge>>
): Promise<string> {
  const mode = args.mode || "help";
  const platformSource = resolvePlatformSource(ctx.platformSource);

  try {
    if (mode === "help") {
      return executeMemoryToolLocal({ mode: "help" }, ctx);
    }

    const result = await bridge.executeTool({
      mode,
      content: args.content,
      query: args.query,
      tags: args.tags,
      type: args.type,
      memoryId: args.memoryId,
      limit: args.limit,
      scope: args.scope,
      platformSource,
    });
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: `Shared runtime request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function executeMemoryToolLocal(
  args: MemoryToolArgs,
  ctx: MemoryToolContext
): Promise<string> {
  const { directory } = ctx;
  const platformSource = resolvePlatformSource(ctx.platformSource);
  const tags = getTags(directory);
  const mode = args.mode || "help";
  const needsEmbedding = !["help", "list-shards", "migrate", "export"].includes(mode);

  if (needsEmbedding) {
    const embeddingInitError = memoryClient.getEmbeddingInitError?.();
    if (embeddingInitError) {
      return JSON.stringify({ success: false, error: embeddingInitError });
    }
  }

  try {
    if (needsEmbedding) {
      await memoryClient.warmup();
    } else if (mode !== "help") {
      await memoryClient.ensureStorageReady();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      success: false,
      error: `Memory system failed to initialize: ${message}`,
    });
  }

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
            {
              command: "profile",
              description:
                "View user profile or save an explicit preference (provide content to write)",
              args: ["content?"],
            },
            { command: "list", description: "List recent memories", args: ["limit?"] },
            { command: "forget", description: "Remove memory", args: ["memoryId"] },
            {
              command: "list-shards",
              description: "List project memory shards and orphaned path associations",
              args: [],
            },
            {
              command: "migrate",
              description:
                "Reassociate orphaned project shards after a directory move (target must be empty)",
              args: ["fromPath?", "fromHash?", "dryRun?", "allowLinkedSource?"],
            },
            {
              command: "export",
              description: "Export current project memories to a portable JSON file",
              args: ["outputPath"],
            },
            {
              command: "import",
              description:
                "Import memories from a portable JSON file (re-embeds; aborts on duplicate ids)",
              args: ["inputPath", "dryRun?"],
            },
          ],
          tagGuidance: "Use technical keywords for search. Tags rank highest.",
          platformSource,
        });

      case "add": {
        if (!args.content) return JSON.stringify({ success: false, error: "content required" });
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
          source: "manual",
          platformSource,
          displayName: tagInfo.displayName,
          userName: tagInfo.userName,
          userEmail: tagInfo.userEmail,
          projectPath: tagInfo.projectPath,
          projectName: tagInfo.projectName,
          gitRepoUrl: tagInfo.gitRepoUrl,
        });
        return JSON.stringify({
          success: result.success,
          message: result.success ? `Memory added` : result.error,
          id: result.success ? result.id : undefined,
          tags: parsedTags,
          platformSource,
        });
      }

      case "search": {
        if (!args.query) return JSON.stringify({ success: false, error: "query required" });
        const searchRes = await memoryClient.searchMemories(
          args.query,
          tags.project.tag,
          args.scope ?? CONFIG.memory.defaultScope
        );
        if (!searchRes.success) return JSON.stringify({ success: false, error: searchRes.error });
        return formatSearchResults(args.query, searchRes, args.limit);
      }

      case "profile": {
        if (args.query) {
          return JSON.stringify({
            success: false,
            error:
              "query is not valid for profile mode. Use content to write a preference or omit all args to read.",
          });
        }

        const { userProfileManager } = await import("../../user-profile/user-profile-manager.js");
        const { toPublicProfileData } = await import("../../user-profile/profile-utils.js");
        const { tryAcquireProfileLearningLock } =
          await import("../../user-profile/learning-lock.js");

        const userId = tags.user.userEmail || "unknown";

        if (args.content !== undefined) {
          const trimmed = args.content.trim();
          if (!trimmed) {
            return JSON.stringify({ success: false, error: "content must not be blank" });
          }

          if (!tags.user.userEmail) {
            return JSON.stringify({
              success: false,
              error:
                "Cannot save profile preference because no user email could be resolved. Configure userEmailOverride or git user.email.",
            });
          }

          const sanitizedContent = stripPrivateContent(trimmed);
          const hasNonPrivateContent =
            sanitizedContent.replace(/\[REDACTED\]/g, "").trim().length > 0;

          if (isFullyPrivate(trimmed) || !hasNonPrivateContent) {
            return JSON.stringify({ success: false, error: "Private content blocked" });
          }

          const releaseProfileWriteLock = await tryAcquireProfileLearningLock(directory);
          if (!releaseProfileWriteLock) {
            return JSON.stringify({
              success: false,
              error:
                "Profile preference save is temporarily unavailable because profile learning holds the lock. Retry shortly.",
            });
          }

          try {
            const newPreference = {
              category: "explicit",
              description: sanitizedContent,
              confidence: 1.0,
              frequency: 1,
              evidence: ["manual-write"],
              lastSeen: Date.now(),
            };

            const existingProfile = await userProfileManager.getActiveProfile(userId);

            if (existingProfile) {
              const existingData = JSON.parse(existingProfile.profileData);
              const mergedData = await userProfileManager.mergeProfileData(
                existingData,
                {
                  preferences: [newPreference],
                },
                undefined,
                existingProfile.id
              );
              await userProfileManager.updateProfile(
                existingProfile.id,
                mergedData,
                0,
                `Explicit preference added: ${sanitizedContent.slice(0, 80)}`
              );
              return JSON.stringify({
                success: true,
                message: "Preference saved to profile",
              });
            }

            await userProfileManager.createProfile(
              userId,
              tags.user.displayName || userId,
              tags.user.userName || userId,
              tags.user.userEmail || userId,
              { preferences: [newPreference], patterns: [], workflows: [] },
              0
            );
            return JSON.stringify({
              success: true,
              message: "Profile created with preference",
            });
          } finally {
            await releaseProfileWriteLock();
          }
        }

        const profile = await userProfileManager.getActiveProfile(userId);
        if (!profile) return JSON.stringify({ success: true, profile: null });
        const pData = toPublicProfileData(JSON.parse(profile.profileData));
        return JSON.stringify({
          success: true,
          profile: {
            ...pData,
            version: profile.version,
            lastAnalyzed: profile.lastAnalyzedAt,
          },
        });
      }

      case "list": {
        const listRes = await memoryClient.listMemories(
          tags.project.tag,
          args.limit || 20,
          args.scope ?? CONFIG.memory.defaultScope
        );
        if (!listRes.success) return JSON.stringify({ success: false, error: listRes.error });
        return JSON.stringify({
          success: true,
          count: listRes.memories?.length,
          memories: listRes.memories?.map((m: any) => ({
            id: m.id,
            content: m.summary,
            createdAt: m.createdAt,
          })),
        });
      }

      case "forget": {
        if (!args.memoryId) return JSON.stringify({ success: false, error: "memoryId required" });
        const delRes = await memoryClient.deleteMemory(args.memoryId);
        return JSON.stringify({ success: delRes.success, message: `Memory removed` });
      }

      case "list-shards": {
        const listShardsRes = await memoryClient.listShards(directory);
        return JSON.stringify(listShardsRes);
      }

      case "migrate": {
        if (!args.fromPath && !args.fromHash) {
          return JSON.stringify({
            success: false,
            error:
              "fromPath or fromHash required. Run memory list-shards to discover orphaned shards.",
          });
        }
        const migrateRes = await memoryClient.migrateProjectPath({
          currentDirectory: directory,
          fromPath: args.fromPath,
          fromHash: args.fromHash,
          dryRun: args.dryRun,
          allowLinkedSource: args.allowLinkedSource,
        });
        return JSON.stringify(migrateRes);
      }

      case "export": {
        if (!args.outputPath) {
          return JSON.stringify({ success: false, error: "outputPath required" });
        }
        const exportRes = await memoryClient.exportMemories(directory, args.outputPath);
        return JSON.stringify(exportRes);
      }

      case "import": {
        if (!args.inputPath) {
          return JSON.stringify({ success: false, error: "inputPath required" });
        }
        const importRes = await memoryClient.importMemories(directory, args.inputPath, args.dryRun);
        return JSON.stringify(importRes);
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
    }
  } catch (error) {
    return JSON.stringify({ success: false, error: String(error) });
  }
}
