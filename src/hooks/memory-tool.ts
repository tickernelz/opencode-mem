import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { CONFIG, isConfigured } from "../config.js";
import { memoryClient, type MemoryScope } from "../services/client.js";
import { getLanguageName } from "../services/language-detector.js";
import { isFullyPrivate, stripPrivateContent } from "../services/privacy.js";
import type { TagInfo } from "../services/tags.js";
import type { MemoryType } from "../types/index.js";

export function formatSearchResults(query: string, results: any, limit?: number): string {
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

export type MemoryToolArgs = {
  mode?: "add" | "search" | "profile" | "list" | "forget" | "help";
  content?: string;
  query?: string;
  tags?: string;
  type?: MemoryType;
  memoryId?: string;
  limit?: number;
  scope?: MemoryScope;
};

export async function executeMemoryTool(
  args: MemoryToolArgs,
  tags: { user: TagInfo; project: TagInfo }
): Promise<string> {
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
            {
              command: "profile",
              description:
                "View user profile or save an explicit preference (provide content to write)",
              args: ["content?"],
            },
            { command: "list", description: "List recent memories", args: ["limit?"] },
            { command: "forget", description: "Remove memory", args: ["memoryId"] },
          ],
          tagGuidance: "Use technical keywords for search. Tags rank highest.",
        });

      case "add":
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
        const searchRes = await memoryClient.searchMemories(
          args.query,
          tags.project.tag,
          args.scope ?? CONFIG.memory.defaultScope
        );
        if (!searchRes.success) return JSON.stringify({ success: false, error: searchRes.error });
        return formatSearchResults(args.query, searchRes, args.limit);

      case "profile": {
        if (args.query) {
          return JSON.stringify({
            success: false,
            error:
              "query is not valid for profile mode. Use content to write a preference or omit all args to read.",
          });
        }

        const { userProfileManager } =
          await import("../services/user-profile/user-profile-manager.js");

        const userId = tags.user.userEmail || "unknown";

        // --- WRITE: explicit preference ---
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

          const sanitizedPreference = stripPrivateContent(trimmed);
          const hasNonPrivateContent =
            sanitizedPreference.replace(/\[REDACTED\]/g, "").trim().length > 0;

          if (isFullyPrivate(trimmed) || !hasNonPrivateContent) {
            return JSON.stringify({ success: false, error: "Private content blocked" });
          }

          const newPreference = {
            category: "explicit",
            description: sanitizedPreference,
            confidence: 1.0,
            frequency: 1,
            evidence: ["manual-write"],
            lastSeen: Date.now(),
          };

          const existingProfile = userProfileManager.getActiveProfile(userId);

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
            userProfileManager.updateProfile(
              existingProfile.id,
              mergedData,
              0,
              `Explicit preference added: ${sanitizedPreference.slice(0, 80)}`
            );
            return JSON.stringify({
              success: true,
              message: "Preference saved to profile",
            });
          } else {
            userProfileManager.createProfile(
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
          }
        }

        // --- READ: no content provided ---
        const profile = userProfileManager.getActiveProfile(userId);
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
      }

      case "list":
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

      case "forget":
        if (!args.memoryId) return JSON.stringify({ success: false, error: "memoryId required" });
        const delRes = await memoryClient.deleteMemory(args.memoryId);
        return JSON.stringify({ success: delRes.success, message: `Memory removed` });

      default:
        return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
    }
  } catch (error) {
    return JSON.stringify({ success: false, error: String(error) });
  }
}

export function createMemoryTool(tags: { user: TagInfo; project: TagInfo }): ToolDefinition {
  return tool({
    description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName(CONFIG.autoCaptureLanguage || "en")}). Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for preferences. Search/list scope: project or all-projects.`,
    args: {
      mode: tool.schema.enum(["add", "search", "profile", "list", "forget", "help"]).optional(),
      content: tool.schema.string().optional(),
      query: tool.schema.string().optional(),
      tags: tool.schema.string().optional(),
      type: tool.schema.string().optional(),
      memoryId: tool.schema.string().optional(),
      limit: tool.schema.number().optional(),
      scope: tool.schema.enum(["project", "all-projects"]).optional(),
    },
    async execute(args: MemoryToolArgs) {
      return executeMemoryTool(args, tags);
    },
  });
}
