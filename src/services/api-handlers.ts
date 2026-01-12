import { embeddingService } from "./embedding.js";
import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

interface Memory {
  id: string;
  content: string;
  type?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
}

interface TagInfo {
  tag: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);

    if (isNaN(numValue) || numValue < 0) {
      return new Date().toISOString();
    }

    return new Date(numValue).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeJSONParse(jsonString: any): any {
  if (!jsonString || typeof jsonString !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

function extractScopeFromTag(tag: string): { scope: "project"; hash: string } {
  const parts = tag.split("_");
  if (parts.length >= 3) {
    const hash = parts.slice(2).join("_");
    return { scope: "project", hash };
  }
  return { scope: "project", hash: tag };
}

function getProjectPathFromTag(tag: string): string | undefined {
  const projectShards = shardManager.getAllShards("project", "");

  for (const shard of projectShards) {
    const db = connectionManager.getConnection(shard.dbPath);
    const tags = vectorSearch.getDistinctTags(db);

    for (const t of tags) {
      if (t.container_tag === tag && t.project_path) {
        return t.project_path;
      }
    }
  }

  return undefined;
}

export async function handleListTags(): Promise<ApiResponse<{ project: TagInfo[] }>> {
  try {
    await embeddingService.warmup();

    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...projectShards];

    const tagsMap = new Map<string, TagInfo>();

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const tags = vectorSearch.getDistinctTags(db);

      for (const t of tags) {
        if (t.container_tag && !tagsMap.has(t.container_tag)) {
          tagsMap.set(t.container_tag, {
            tag: t.container_tag,
            displayName: t.display_name,
            userName: t.user_name,
            userEmail: t.user_email,
            projectPath: t.project_path,
            projectName: t.project_name,
            gitRepoUrl: t.git_repo_url,
          });
        }
      }
    }

    const projectTags: TagInfo[] = [];

    for (const tagInfo of tagsMap.values()) {
      if (tagInfo.tag.includes("_project_")) {
        projectTags.push(tagInfo);
      }
    }

    return {
      success: true,
      data: { project: projectTags },
    };
  } catch (error) {
    log("handleListTags: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleListMemories(
  tag?: string,
  page: number = 1,
  pageSize: number = 20,
  includePrompts: boolean = true
): Promise<ApiResponse<PaginatedResponse<Memory | any>>> {
  try {
    await embeddingService.warmup();

    let allMemories: any[] = [];

    if (tag) {
      const { scope: tagScope, hash } = extractScopeFromTag(tag);
      const shards = shardManager.getAllShards(tagScope, hash);

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.listMemories(db, tag, 10000);
        allMemories.push(...memories);
      }
    } else {
      const shards = shardManager.getAllShards("project", "");

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.getAllMemories(db);
        allMemories.push(...memories.filter((m: any) => m.container_tag?.includes(`_project_`)));
      }
    }

    const memoriesWithType = allMemories.map((r: any) => {
      const metadata = safeJSONParse(r.metadata);
      return {
        type: "memory",
        id: r.id,
        content: r.content,
        memoryType: r.type,
        createdAt: Number(r.created_at),
        updatedAt: r.updated_at ? Number(r.updated_at) : undefined,
        metadata,
        linkedPromptId: metadata?.promptId,
        displayName: r.display_name,
        userName: r.user_name,
        userEmail: r.user_email,
        projectPath: r.project_path,
        projectName: r.project_name,
        gitRepoUrl: r.git_repo_url,
        isPinned: r.is_pinned === 1,
      };
    });

    let timeline: any[] = memoriesWithType;

    if (includePrompts) {
      const projectPath = tag ? getProjectPathFromTag(tag) : undefined;
      const prompts = userPromptManager.getCapturedPrompts(projectPath);
      const promptsWithType = prompts.map((p) => ({
        type: "prompt",
        id: p.id,
        sessionId: p.sessionId,
        content: p.content,
        createdAt: p.createdAt,
        projectPath: p.projectPath,
        linkedMemoryId: p.linkedMemoryId,
      }));

      timeline = [...memoriesWithType, ...promptsWithType];
    }

    const linkedPairs = new Map<string, { memory: any; prompt: any }>();
    const standalone: any[] = [];

    for (const item of timeline) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!linkedPairs.has(item.linkedPromptId)) {
          linkedPairs.set(item.linkedPromptId, { memory: item, prompt: null });
        } else {
          linkedPairs.get(item.linkedPromptId)!.memory = item;
        }
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!linkedPairs.has(item.id)) {
          linkedPairs.set(item.id, { memory: null, prompt: item });
        } else {
          linkedPairs.get(item.id)!.prompt = item;
        }
      } else {
        standalone.push(item);
      }
    }

    const sortedTimeline: any[] = [];

    const pairs = Array.from(linkedPairs.values())
      .filter((p) => p.memory && p.prompt)
      .sort((a, b) => b.memory.createdAt - a.memory.createdAt);

    for (const pair of pairs) {
      sortedTimeline.push(pair.memory);
      sortedTimeline.push(pair.prompt);
    }

    standalone.sort((a, b) => b.createdAt - a.createdAt);
    sortedTimeline.push(...standalone);

    timeline = sortedTimeline;

    const total = timeline.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;

    const paginatedResults = timeline.slice(offset, offset + pageSize);

    const items = paginatedResults.map((item: any) => {
      if (item.type === "memory") {
        return {
          type: "memory",
          id: item.id,
          content: item.content,
          memoryType: item.memoryType,
          createdAt: safeToISOString(item.createdAt),
          updatedAt: item.updatedAt ? safeToISOString(item.updatedAt) : undefined,
          metadata: item.metadata,
          linkedPromptId: item.linkedPromptId,
          displayName: item.displayName,
          userName: item.userName,
          userEmail: item.userEmail,
          projectPath: item.projectPath,
          projectName: item.projectName,
          gitRepoUrl: item.gitRepoUrl,
          isPinned: item.isPinned,
        };
      } else {
        return {
          type: "prompt",
          id: item.id,
          sessionId: item.sessionId,
          content: item.content,
          createdAt: safeToISOString(item.createdAt),
          projectPath: item.projectPath,
          linkedMemoryId: item.linkedMemoryId,
        };
      }
    });

    return {
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages,
      },
    };
  } catch (error) {
    log("handleListMemories: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleAddMemory(data: {
  content: string;
  containerTag: string;
  type?: MemoryType;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}): Promise<ApiResponse<{ id: string }>> {
  try {
    if (!data.content || !data.containerTag) {
      return { success: false, error: "content and containerTag are required" };
    }

    await embeddingService.warmup();

    const vector = await embeddingService.embedWithTimeout(data.content);
    const { scope, hash } = extractScopeFromTag(data.containerTag);

    const shard = shardManager.getWriteShard(scope, hash);

    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();

    const record = {
      id,
      content: data.content,
      vector,
      containerTag: data.containerTag,
      type: data.type,
      createdAt: now,
      updatedAt: now,
      displayName: data.displayName,
      userName: data.userName,
      userEmail: data.userEmail,
      projectPath: data.projectPath,
      projectName: data.projectName,
      gitRepoUrl: data.gitRepoUrl,
      metadata: JSON.stringify({
        source: "api",
      }),
    };

    const db = connectionManager.getConnection(shard.dbPath);
    vectorSearch.insertVector(db, record);
    shardManager.incrementVectorCount(shard.id);

    return { success: true, data: { id } };
  } catch (error) {
    log("handleAddMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeleteMemory(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedPrompt: boolean }>> {
  try {
    if (!id) {
      return { success: false, error: "id is required" };
    }

    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...projectShards];

    let deletedPrompt = false;

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);

      if (memory) {
        if (cascade) {
          const metadata = safeJSONParse(memory.metadata);
          const linkedPromptId = metadata?.promptId;

          if (linkedPromptId) {
            userPromptManager.deletePrompt(linkedPromptId);
            deletedPrompt = true;
          }
        }

        vectorSearch.deleteVector(db, id);
        shardManager.decrementVectorCount(shard.id);
        return { success: true, data: { deletedPrompt } };
      }
    }

    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handleDeleteMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDelete(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) {
      return { success: false, error: "ids array is required" };
    }

    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeleteMemory(id, cascade);
      if (result.success) {
        deleted++;
      }
    }

    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDelete: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUpdateMemory(
  id: string,
  data: { content?: string; type?: MemoryType }
): Promise<ApiResponse<void>> {
  try {
    if (!id) {
      return { success: false, error: "id is required" };
    }

    await embeddingService.warmup();

    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...projectShards];

    let foundShard = null;
    let existingMemory = null;

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);

      if (memory) {
        foundShard = shard;
        existingMemory = memory;
        break;
      }
    }

    if (!foundShard || !existingMemory) {
      return { success: false, error: "Memory not found" };
    }

    const db = connectionManager.getConnection(foundShard.dbPath);
    vectorSearch.deleteVector(db, id);
    shardManager.decrementVectorCount(foundShard.id);

    const newContent = data.content || existingMemory.content;
    const vector = await embeddingService.embedWithTimeout(newContent);

    const updatedRecord = {
      id,
      content: newContent,
      vector,
      containerTag: existingMemory.container_tag,
      type: data.type || existingMemory.type,
      createdAt: existingMemory.created_at,
      updatedAt: Date.now(),
      metadata: existingMemory.metadata,
      displayName: existingMemory.display_name,
      userName: existingMemory.user_name,
      userEmail: existingMemory.user_email,
      projectPath: existingMemory.project_path,
      projectName: existingMemory.project_name,
      gitRepoUrl: existingMemory.git_repo_url,
    };

    vectorSearch.insertVector(db, updatedRecord);
    shardManager.incrementVectorCount(foundShard.id);

    return { success: true };
  } catch (error) {
    log("handleUpdateMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleSearch(
  query: string,
  tag?: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<PaginatedResponse<Memory & { similarity: number }>>> {
  try {
    if (!query) {
      return { success: false, error: "query is required" };
    }

    await embeddingService.warmup();

    const queryVector = await embeddingService.embedWithTimeout(query);
    let allResults: any[] = [];

    if (tag) {
      const { scope, hash } = extractScopeFromTag(tag);
      const shards = shardManager.getAllShards(scope, hash);

      for (const shard of shards) {
        try {
          const results = vectorSearch.searchInShard(shard, queryVector, tag, pageSize * 2);
          allResults.push(...results);
        } catch (error) {
          log("Shard search error", { shardId: shard.id, error: String(error) });
        }
      }
    } else {
      const projectShards = shardManager.getAllShards("project", "");
      const allShards = [...projectShards];

      const uniqueTags = new Set<string>();
      for (const shard of allShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const tags = vectorSearch.getDistinctTags(db);
        for (const t of tags) {
          if (t.container_tag) {
            uniqueTags.add(t.container_tag);
          }
        }
      }

      for (const containerTag of uniqueTags) {
        const { scope, hash } = extractScopeFromTag(containerTag);
        const shards = shardManager.getAllShards(scope, hash);

        for (const shard of shards) {
          try {
            const results = vectorSearch.searchInShard(shard, queryVector, containerTag, pageSize);
            allResults.push(...results);
          } catch (error) {
            log("Shard search error", { shardId: shard.id, error: String(error) });
          }
        }
      }
    }

    const sortedResults = allResults.sort((a: any, b: any) => b.similarity - a.similarity);

    const total = sortedResults.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;

    const paginatedResults = sortedResults.slice(offset, offset + pageSize);

    const memories = paginatedResults.map((r: any) => ({
      id: r.id,
      content: r.memory,
      type: r.metadata?.type,
      createdAt: safeToISOString(r.metadata?.createdAt),
      updatedAt: r.metadata?.updatedAt ? safeToISOString(r.metadata.updatedAt) : undefined,
      similarity: Math.round(r.similarity * 100),
      metadata: r.metadata,
      displayName: r.displayName,
      userName: r.userName,
      userEmail: r.userEmail,
      projectPath: r.projectPath,
      projectName: r.projectName,
      gitRepoUrl: r.gitRepoUrl,
      isPinned: r.isPinned === 1,
    }));

    return {
      success: true,
      data: {
        items: memories,
        total,
        page,
        pageSize,
        totalPages,
      },
    };
  } catch (error) {
    log("handleSearch: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleStats(): Promise<
  ApiResponse<{
    total: number;
    byScope: { user: number; project: number };
    byType: Record<string, number>;
  }>
> {
  try {
    await embeddingService.warmup();

    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...projectShards];

    let userCount = 0;
    let projectCount = 0;
    const typeCount: Record<string, number> = {};

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memories = vectorSearch.getAllMemories(db);

      for (const r of memories) {
        if (r.container_tag?.includes("_user_")) {
          userCount++;
        } else if (r.container_tag?.includes("_project_")) {
          projectCount++;
        }

        if (r.type) {
          typeCount[r.type] = (typeCount[r.type] || 0) + 1;
        }
      }
    }

    return {
      success: true,
      data: {
        total: userCount + projectCount,
        byScope: { user: userCount, project: projectCount },
        byType: typeCount,
      },
    };
  } catch (error) {
    log("handleStats: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handlePinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) {
      return { success: false, error: "id is required" };
    }

    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...projectShards];

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);

      if (memory) {
        vectorSearch.pinMemory(db, id);
        return { success: true };
      }
    }

    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handlePinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUnpinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) {
      return { success: false, error: "id is required" };
    }

    const projectShards = shardManager.getAllShards("project", "");
    const allShards = [...projectShards];

    for (const shard of allShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);

      if (memory) {
        vectorSearch.unpinMemory(db, id);
        return { success: true };
      }
    }

    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handleUnpinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunCleanup(): Promise<
  ApiResponse<{
    deletedCount: number;
    userCount: number;
    projectCount: number;
  }>
> {
  try {
    const { cleanupService } = await import("./cleanup-service.js");
    const result = await cleanupService.runCleanup();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunDeduplication(): Promise<
  ApiResponse<{
    exactDuplicatesDeleted: number;
    nearDuplicateGroups: any[];
  }>
> {
  try {
    const { deduplicationService } = await import("./deduplication-service.js");
    const result = await deduplicationService.detectAndRemoveDuplicates();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunDeduplication: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectMigration(): Promise<
  ApiResponse<{
    needsMigration: boolean;
    configDimensions: number;
    configModel: string;
    shardMismatches: any[];
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.detectDimensionMismatch();
    return { success: true, data: result };
  } catch (error) {
    log("handleDetectMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunMigration(strategy: "fresh-start" | "re-embed"): Promise<
  ApiResponse<{
    success: boolean;
    strategy: string;
    deletedShards: number;
    reEmbeddedMemories: number;
    duration: number;
    error?: string;
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.migrateToNewModel(strategy);
    return { success: result.success, data: result };
  } catch (error) {
    log("handleRunMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeletePrompt(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedMemory: boolean }>> {
  try {
    if (!id) {
      return { success: false, error: "id is required" };
    }

    const prompt = userPromptManager.getPromptById(id);
    if (!prompt) {
      return { success: false, error: "Prompt not found" };
    }

    let deletedMemory = false;

    if (cascade && prompt.linkedMemoryId) {
      const result = await handleDeleteMemory(prompt.linkedMemoryId, false);
      if (result.success) {
        deletedMemory = true;
      }
    }

    userPromptManager.deletePrompt(id);

    return { success: true, data: { deletedMemory } };
  } catch (error) {
    log("handleDeletePrompt: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDeletePrompts(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) {
      return { success: false, error: "ids array is required" };
    }

    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeletePrompt(id, cascade);
      if (result.success) {
        deleted++;
      }
    }

    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDeletePrompts: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetUserProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const profile = userProfileManager.getActiveProfile(targetUserId);

    if (!profile) {
      return {
        success: true,
        data: {
          exists: false,
          userId: targetUserId,
          message: "No profile found. Keep chatting to build your profile.",
        },
      };
    }

    const profileData = JSON.parse(profile.profileData);

    return {
      success: true,
      data: {
        exists: true,
        id: profile.id,
        userId: profile.userId,
        displayName: profile.displayName,
        userName: profile.userName,
        userEmail: profile.userEmail,
        version: profile.version,
        createdAt: safeToISOString(profile.createdAt),
        lastAnalyzedAt: safeToISOString(profile.lastAnalyzedAt),
        totalPromptsAnalyzed: profile.totalPromptsAnalyzed,
        profileData,
      },
    };
  } catch (error) {
    log("handleGetUserProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileChangelog(
  profileId: string,
  limit: number = 5
): Promise<ApiResponse<any[]>> {
  try {
    if (!profileId) {
      return { success: false, error: "profileId is required" };
    }

    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = userProfileManager.getProfileChangelogs(profileId, limit);

    const formattedChangelogs = changelogs.map((c) => ({
      id: c.id,
      profileId: c.profileId,
      version: c.version,
      changeType: c.changeType,
      changeSummary: c.changeSummary,
      createdAt: safeToISOString(c.createdAt),
    }));

    return { success: true, data: formattedChangelogs };
  } catch (error) {
    log("handleGetProfileChangelog: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileSnapshot(changelogId: string): Promise<ApiResponse<any>> {
  try {
    if (!changelogId) {
      return { success: false, error: "changelogId is required" };
    }

    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = userProfileManager.getProfileChangelogs("", 1000);
    const changelog = changelogs.find((c) => c.id === changelogId);

    if (!changelog) {
      return { success: false, error: "Changelog not found" };
    }

    const profileData = JSON.parse(changelog.profileDataSnapshot);

    return {
      success: true,
      data: {
        version: changelog.version,
        createdAt: safeToISOString(changelog.createdAt),
        profileData,
      },
    };
  } catch (error) {
    log("handleGetProfileSnapshot: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRefreshProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { getTags } = await import("./tags.js");
    const { userPromptManager } = await import("./user-prompt/user-prompt-manager.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const unanalyzedCount = userPromptManager.countUnanalyzedForUserLearning();

    return {
      success: true,
      data: {
        message: "Profile refresh queued",
        unanalyzedPrompts: unanalyzedCount,
        note: "Profile will be updated when threshold is reached",
      },
    };
  } catch (error) {
    log("handleRefreshProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}
