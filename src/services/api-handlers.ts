import { embeddingService } from "./embedding.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { ensureTursoReady } from "./turso/ready.js";
import { formatTagsForEmbedding } from "./turso/vector-utils.js";
import { extractScopeFromContainerTag, tryExtractScopeFromContainerTag } from "./memory-scope.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { MemoryType } from "../types/index.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import type { UserProfileData } from "./user-profile/types.js";
import { sortProfileItems } from "../utils/profile.js";
import type { ShardInfo } from "./turso/types.js";

async function getAllMemoryShards(): Promise<ShardInfo[]> {
  await ensureTursoReady();
  const projectShards = await tursoShardManager.getAllShards("project", "");
  const userShards = await tursoShardManager.getAllShards("user", "");
  return [...projectShards, ...userShards];
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

interface Memory {
  id: string;
  content: string;
  type?: string;
  tags?: string[];
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
  tags?: string[];
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

function extractScopeFromTag(tag: string): { scope: "user" | "project"; hash: string } {
  return extractScopeFromContainerTag(tag);
}

function getProjectPathFromTag(tag: string): Promise<string | undefined> {
  return (async () => {
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const tags = await tursoVectorSearch.getDistinctTags(db);
      for (const t of tags) {
        if (t.container_tag === tag && t.project_path) {
          return String(t.project_path);
        }
      }
    }
    return undefined;
  })();
}

export async function handleListTags(): Promise<ApiResponse<{ project: TagInfo[] }>> {
  try {
    await ensureTursoReady();
    // Tags are stored as SQLite metadata; embedding model is not needed.
    // Calling warmup() here would block on local transformer init in the worker
    // thread and hang every read API. Only handlers that compute similarity
    // (e.g. handleSearch) should warm up the embedding service.
    const projectShards = await tursoShardManager.getAllShards("project", "");
    const tagsMap = new Map<string, TagInfo>();
    for (const shard of projectShards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const tags = await tursoVectorSearch.getDistinctTags(db);
      for (const t of tags) {
        if (t.container_tag && !tagsMap.has(String(t.container_tag))) {
          tagsMap.set(String(t.container_tag), {
            tag: String(t.container_tag),
            displayName: t.display_name ? String(t.display_name) : undefined,
            userName: t.user_name ? String(t.user_name) : undefined,
            userEmail: t.user_email ? String(t.user_email) : undefined,
            projectPath: t.project_path ? String(t.project_path) : undefined,
            projectName: t.project_name ? String(t.project_name) : undefined,
            gitRepoUrl: t.git_repo_url ? String(t.git_repo_url) : undefined,
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
    return { success: true, data: { project: projectTags } };
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
    await ensureTursoReady();
    // Listing only reads SQLite rows; no vector ops happen here.
    // See handleListTags comment - keep embedding init out of read paths.
    let allMemories: any[] = [];
    if (tag) {
      const { scope: tagScope, hash } = extractScopeFromTag(tag);
      const shards = await tursoShardManager.getAllShards(tagScope, hash);
      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.listMemories(db, tag, 10000);
        allMemories.push(...memories);
      }
    } else {
      // Iterate both project- and user-scoped shards. Previously this only
      // walked project shards, which silently hid user-scope memories from the
      // listing endpoint (Web UI navigation, /api/memories without a tag
      // filter, …). User-scope memories still showed up in /api/search and
      // /api/stats `byType`, but were invisible in /api/stats `byScope` and
      // unbrowseable in the UI — a confusing UX gap. The filter keeps the
      // defense-in-depth check on container_tag, just widens it to both
      // canonical scope markers.
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const userShards = await tursoShardManager.getAllShards("user", "");
      for (const shard of [...projectShards, ...userShards]) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.getAllMemories(db);
        allMemories.push(
          ...memories.filter(
            (m: any) =>
              m.container_tag?.includes("_project_") || m.container_tag?.includes("_user_")
          )
        );
      }
    }

    const memoriesWithType = allMemories.map((r: any) => {
      const metadata = safeJSONParse(r.metadata);
      return {
        type: "memory",
        id: r.id,
        content: r.content,
        memoryType: r.type,
        tags: r.tags ? r.tags.split(",").map((t: string) => t.trim()) : [],
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
      const projectPath = tag ? await getProjectPathFromTag(tag) : undefined;
      const prompts = await userPromptManager.getCapturedPrompts(projectPath);
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
          tags: item.tags,
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

    return { success: true, data: { items, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleListMemories: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleAddMemory(data: {
  content: string;
  containerTag: string;
  type?: MemoryType;
  tags?: string[];
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
    await ensureTursoReady();
    await embeddingService.warmup();
    const tags = (data.tags || []).map((t) => t.trim().toLowerCase());
    const embeddingInput =
      tags.length > 0 ? `${data.content}\nTags: ${tags.join(", ")}` : data.content;

    const vector = await embeddingService.embedWithTimeout(embeddingInput);
    let tagsVector: Float32Array | undefined = undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags));
    }

    const { scope, hash } = extractScopeFromTag(data.containerTag);

    return tursoShardManager.withScopeWriteLock(scope, hash, async () => {
      const shard = await tursoShardManager.getWriteShard(scope, hash);

      const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const now = Date.now();

      const record = {
        id,
        content: data.content,
        vector,
        tagsVector,
        containerTag: data.containerTag,
        tags: tags.length > 0 ? tags.join(",") : undefined,
        type: data.type,
        createdAt: now,
        updatedAt: now,
        displayName: data.displayName,
        userName: data.userName,
        userEmail: data.userEmail,
        projectPath: data.projectPath,
        projectName: data.projectName,
        gitRepoUrl: data.gitRepoUrl,
        metadata: JSON.stringify({ source: "api" }),
      };
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      await tursoVectorSearch.insertVector(db, record);
      await tursoShardManager.incrementVectorCount(shard.id);
      return { success: true as const, data: { id } };
    });
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
    if (!id) return { success: false, error: "id is required" };
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        if (cascade) {
          const metadata = safeJSONParse(memory.metadata);
          const linkedPromptId = metadata?.promptId;
          if (linkedPromptId) await userPromptManager.deletePrompt(linkedPromptId);
        }
        await tursoVectorSearch.deleteVector(db, id);
        await tursoShardManager.decrementVectorCount(shard.id);
        return {
          success: true,
          data: { deletedPrompt: cascade && !!safeJSONParse(memory.metadata)?.promptId },
        };
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
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeleteMemory(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDelete: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUpdateMemory(
  id: string,
  data: { content?: string; type?: MemoryType; tags?: string[] }
): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    await embeddingService.warmup();

    // Find the existing memory first (read-only — no data modified yet)
    const shards = await getAllMemoryShards();
    let foundShard = null,
      existingMemory = null;
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        foundShard = shard;
        existingMemory = memory;
        break;
      }
    }
    if (!foundShard || !existingMemory) return { success: false, error: "Memory not found" };

    // STEP 1: Generate new embeddings FIRST (safe — no data deleted yet)
    const newContent = data.content || String(existingMemory.content);
    const existingTags = existingMemory.tags ? String(existingMemory.tags) : "";
    const tags =
      data.tags || (existingTags ? existingTags.split(",").map((t: string) => t.trim()) : []);
    const vector = await embeddingService.embedWithTimeout(newContent);
    let tagsVector: Float32Array | undefined = undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(formatTagsForEmbedding(tags));
    }

    const db = await tursoConnectionManager.getConnection(foundShard.dbPath);

    await db.transaction("write", async (tx) => {
      await tx.execute({ sql: `DELETE FROM memories WHERE id = ?`, args: [id] });
      await tx.execute({
        sql: `
        INSERT INTO memories (
          id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
          metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
        ) VALUES (?, ?, vector32(?), ${tagsVector ? "vector32(?)" : "NULL"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        args: [
          id,
          newContent,
          JSON.stringify(Array.from(vector)),
          ...(tagsVector ? [JSON.stringify(Array.from(tagsVector))] : []),
          String(existingMemory.container_tag),
          tags.length > 0 ? tags.join(",") : null,
          data.type || (existingMemory.type ? String(existingMemory.type) : null),
          Number(existingMemory.created_at),
          Date.now(),
          existingMemory.metadata ? String(existingMemory.metadata) : null,
          existingMemory.display_name ? String(existingMemory.display_name) : null,
          existingMemory.user_name ? String(existingMemory.user_name) : null,
          existingMemory.user_email ? String(existingMemory.user_email) : null,
          existingMemory.project_path ? String(existingMemory.project_path) : null,
          existingMemory.project_name ? String(existingMemory.project_name) : null,
          existingMemory.git_repo_url ? String(existingMemory.git_repo_url) : null,
        ],
      });
    });

    return { success: true };
  } catch (error) {
    log("handleUpdateMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

interface FormattedPrompt {
  type: "prompt";
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  projectPath: string | null;
  linkedMemoryId: string | null;
  similarity?: number;
  isContext?: boolean;
}

interface FormattedMemory {
  type: "memory";
  id: string;
  content: string;
  memoryType?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  similarity?: number;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
  linkedPromptId?: string;
  isContext?: boolean;
}

type SearchResultItem = FormattedPrompt | FormattedMemory;

export async function handleSearch(
  query: string,
  tag?: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<PaginatedResponse<SearchResultItem>>> {
  try {
    if (!query) return { success: false, error: "query is required" };
    await ensureTursoReady();
    await embeddingService.warmup();
    const queryVector = await embeddingService.embedWithTimeout(query);
    let memoryResults: any[] = [];
    let promptResults: any[] = [];
    if (tag) {
      const { scope, hash } = extractScopeFromTag(tag);
      const shards = await tursoShardManager.getAllShards(scope, hash);
      for (const shard of shards) {
        try {
          const results = await tursoVectorSearch.searchInShard(
            shard,
            queryVector,
            tag,
            pageSize * 2
          );
          memoryResults.push(...results);
        } catch (error) {
          log("Shard search error", { shardId: shard.id, error: String(error) });
        }
      }
      const projectPath = await getProjectPathFromTag(tag);
      promptResults = await userPromptManager.searchPrompts(query, projectPath, pageSize * 2);
    } else {
      const allShards = await getAllMemoryShards();
      const uniqueTags = new Set<string>();
      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const tags = await tursoVectorSearch.getDistinctTags(db);
        for (const t of tags) {
          if (t.container_tag) uniqueTags.add(String(t.container_tag));
        }
      }
      for (const containerTag of uniqueTags) {
        const parsed = tryExtractScopeFromContainerTag(containerTag);
        if (!parsed) {
          log("Skipping invalid container_tag during global search", { containerTag });
          continue;
        }
        const { scope, hash } = parsed;
        const shards = await tursoShardManager.getAllShards(scope, hash);
        for (const shard of shards) {
          try {
            const results = await tursoVectorSearch.searchInShard(
              shard,
              queryVector,
              containerTag,
              pageSize
            );
            memoryResults.push(...results);
          } catch (error) {
            log("Shard search error", { shardId: shard.id, error: String(error) });
          }
        }
      }
      promptResults = await userPromptManager.searchPrompts(query, undefined, pageSize * 2);
    }

    const formattedPrompts: FormattedPrompt[] = promptResults.map((p) => ({
      type: "prompt",
      id: p.id,
      sessionId: p.sessionId,
      content: p.content,
      createdAt: safeToISOString(p.createdAt),
      projectPath: p.projectPath,
      linkedMemoryId: p.linkedMemoryId,
      similarity: 1.0,
    }));

    const formattedMemories: FormattedMemory[] = memoryResults.map((r: any) => ({
      type: "memory",
      id: r.id,
      content: r.memory,
      memoryType: r.metadata?.type,
      tags: r.tags,
      createdAt: safeToISOString(r.createdAt ?? r.metadata?.createdAt),
      updatedAt: r.metadata?.updatedAt ? safeToISOString(r.metadata.updatedAt) : undefined,
      similarity: r.similarity,
      metadata: r.metadata,
      displayName: r.displayName,
      userName: r.userName,
      userEmail: r.userEmail,
      projectPath: r.projectPath,
      projectName: r.projectName,
      gitRepoUrl: r.gitRepoUrl,
      isPinned: r.isPinned === 1,
      linkedPromptId: r.metadata?.promptId,
    }));

    const combinedResults = [...formattedMemories, ...formattedPrompts].sort(
      (a: any, b: any) =>
        (b.similarity || 0) - (a.similarity || 0) || b.createdAt.localeCompare(a.createdAt)
    );

    const total = combinedResults.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults: SearchResultItem[] = combinedResults.slice(offset, offset + pageSize);

    const missingPromptIds = new Set<string>();
    const missingMemoryIds = new Set<string>();
    for (const item of paginatedResults) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!paginatedResults.some((p) => p.id === item.linkedPromptId))
          missingPromptIds.add(item.linkedPromptId);
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!paginatedResults.some((m) => m.id === item.linkedMemoryId))
          missingMemoryIds.add(item.linkedMemoryId);
      }
    }

    if (missingPromptIds.size > 0) {
      const extraPrompts = await userPromptManager.getPromptsByIds(Array.from(missingPromptIds));
      for (const p of extraPrompts) {
        paginatedResults.push({
          type: "prompt",
          id: p.id,
          sessionId: p.sessionId,
          content: p.content,
          createdAt: safeToISOString(p.createdAt),
          projectPath: p.projectPath,
          linkedMemoryId: p.linkedMemoryId,
          similarity: 0,
          isContext: true,
        });
      }
    }

    if (missingMemoryIds.size > 0) {
      const shards = await getAllMemoryShards();
      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        for (const mid of missingMemoryIds) {
          const m = await tursoVectorSearch.getMemoryById(db, mid);
          if (m && !paginatedResults.some((existing) => existing.id === m.id)) {
            paginatedResults.push({
              type: "memory",
              id: String(m.id),
              content: String(m.content),
              memoryType: m.type ? String(m.type) : undefined,
              tags: m.tags
                ? String(m.tags)
                    .split(",")
                    .map((t: string) => t.trim())
                : [],
              createdAt: safeToISOString(m.created_at),
              updatedAt: m.updated_at ? safeToISOString(m.updated_at) : undefined,
              similarity: 0,
              metadata: safeJSONParse(m.metadata),
              displayName: m.display_name ? String(m.display_name) : undefined,
              userName: m.user_name ? String(m.user_name) : undefined,
              userEmail: m.user_email ? String(m.user_email) : undefined,
              projectPath: m.project_path ? String(m.project_path) : undefined,
              projectName: m.project_name ? String(m.project_name) : undefined,
              gitRepoUrl: m.git_repo_url ? String(m.git_repo_url) : undefined,
              isPinned: Number(m.is_pinned) === 1,
              linkedPromptId: safeJSONParse(m.metadata)?.promptId,
              isContext: true,
            });
          }
        }
      }
    }

    return { success: true, data: { items: paginatedResults, total, page, pageSize, totalPages } };
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
    // Stats only counts Turso/libSQL rows; no embedding needed.
    // See handleListTags comment - keep embedding init out of read paths.
    const shards = await getAllMemoryShards();
    let userCount = 0,
      projectCount = 0;
    const typeCount: Record<string, number> = {};
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memories = await tursoVectorSearch.getAllMemories(db);
      for (const r of memories) {
        const containerTag = String(r.container_tag ?? "");
        const type = r.type ? String(r.type) : "";
        if (containerTag.includes("_user_")) userCount++;
        else if (containerTag.includes("_project_")) projectCount++;
        if (type) typeCount[type] = (typeCount[type] || 0) + 1;
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
    if (!id) return { success: false, error: "id is required" };
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        await tursoVectorSearch.pinMemory(db, id);
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
    if (!id) return { success: false, error: "id is required" };
    const shards = await getAllMemoryShards();
    for (const shard of shards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memory = await tursoVectorSearch.getMemoryById(db, id);
      if (memory) {
        await tursoVectorSearch.unpinMemory(db, id);
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
  ApiResponse<{ deletedCount: number; userCount: number; projectCount: number }>
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
  ApiResponse<{ exactDuplicatesDeleted: number; nearDuplicateGroups: any[] }>
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
    if (!id) return { success: false, error: "id is required" };
    const prompt = await userPromptManager.getPromptById(id);
    if (!prompt) return { success: false, error: "Prompt not found" };
    let deletedMemory = false;
    if (cascade && prompt.linkedMemoryId) {
      const result = await handleDeleteMemory(prompt.linkedMemoryId, false);
      if (result.success) deletedMemory = true;
    }
    await userPromptManager.deletePrompt(id);
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
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeletePrompt(id, cascade);
      if (result.success) deleted++;
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
    const profile = await userProfileManager.getActiveProfile(targetUserId);
    if (!profile)
      return {
        success: true,
        data: {
          exists: false,
          userId: targetUserId,
          message: "No profile found. Keep chatting to build your profile.",
        },
      };
    const profileData = JSON.parse(profile.profileData);
    profileData.preferences = sortProfileItems(profileData.preferences as any[], "confidence");
    profileData.patterns = sortProfileItems(profileData.patterns as any[], "frequency");
    profileData.workflows = sortProfileItems(profileData.workflows as any[], "frequency");
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
    if (!profileId) return { success: false, error: "profileId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = await userProfileManager.getProfileChangelogs(profileId, limit);
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
    if (!changelogId) return { success: false, error: "changelogId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelog = await userProfileManager.getChangelogById(changelogId);
    if (!changelog) return { success: false, error: "Changelog not found" };
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
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { userPromptManager } = await import("./user-prompt/user-prompt-manager.js");
    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }
    const profile = await userProfileManager.getActiveProfile(targetUserId);
    let decayApplied = false;
    if (profile) {
      const pData = JSON.parse(profile.profileData);
      const { data: decayed, hasChanges } = userProfileManager.decayInMemory(pData);
      if (hasChanges) {
        await userProfileManager.updateProfile(profile.id, decayed, 0, "Applied confidence decay");
        decayApplied = true;
      }
    }
    const unanalyzedCount = await userPromptManager.countUnanalyzedForUserLearning();
    return {
      success: true,
      data: {
        message: decayApplied ? "Profile confidence decay applied" : "Profile refresh queued",
        profileExists: Boolean(profile),
        decayApplied,
        unanalyzedPrompts: unanalyzedCount,
        note: "Confidence decay runs immediately; AI profile learning still runs when the prompt threshold is reached",
      },
    };
  } catch (error) {
    log("handleRefreshProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

// Temporary storage for pending AI cleanup results (userId → result)
const pendingCleanups = new Map<
  string,
  {
    cleaned: UserProfileData;
    oldProfileData: UserProfileData;
    diff: any;
    allMergedIds: string[][];
    allRemovedIds: string[];
    expiresAt: number;
  }
>();

export async function handleAICleanup(
  userId?: string,
  includeIds?: string[]
): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");
    const { aiCleanupProfile, aiCleanupProfileFromIndexed, filterProfileForCleanup } =
      await import("./user-profile/ai-cleanup.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const profile = await userProfileManager.getActiveProfile(targetUserId);
    if (!profile) {
      return { success: false, error: "No profile found to clean up" };
    }

    const profileData: UserProfileData = JSON.parse(profile.profileData);

    let indexed;
    let result;
    if (includeIds && includeIds.length > 0) {
      indexed = filterProfileForCleanup(profileData, includeIds);
      result = await aiCleanupProfileFromIndexed(indexed);
    } else {
      result = await aiCleanupProfile(profileData);
    }

    pendingCleanups.set(targetUserId, {
      cleaned: result.cleaned,
      oldProfileData: profileData,
      diff: result.diff,
      allMergedIds: (result.diff?.merged || []).map((m: any) => m.ids || []),
      allRemovedIds: (result.diff?.removed || []).map((r: any) => r.id),
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return {
      success: true,
      data: {
        old: profileData,
        new: result.cleaned,
        changes: result.diff,
      },
    };
  } catch (error) {
    log("handleAICleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleApplyCleanup(userId?: string, body?: any): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const pending = pendingCleanups.get(targetUserId);
    if (!pending) {
      return { success: false, error: "No pending cleanup found. Run AI cleanup first." };
    }

    if (Date.now() > pending.expiresAt) {
      pendingCleanups.delete(targetUserId);
      return { success: false, error: "Cleanup session expired. Run AI cleanup again." };
    }

    const profile = await userProfileManager.getActiveProfile(targetUserId);
    if (!profile) {
      return { success: false, error: "Profile not found" };
    }

    const cleanedData = body?.profile || pending.cleaned;
    const acceptedMerged: string[][] = body?.acceptedMerged || [];
    const acceptedRemoved: string[] = body?.acceptedRemoved || [];

    // Partial application: start from cleaned data (which has shrunk descriptions)
    // and only apply removals for items the user unchecked.
    if (acceptedMerged.length > 0 || acceptedRemoved.length > 0) {
      const existingData: UserProfileData = JSON.parse(profile.profileData);
      const result: UserProfileData = {
        preferences: [...cleanedData.preferences],
        patterns: [...cleanedData.patterns],
        workflows: [...cleanedData.workflows],
      };

      // Remove items the user chose NOT to merge (revert to old descriptions)
      for (const id of acceptedRemoved) {
        const desc = findItemDesc(pending.oldProfileData, id);
        if (desc) removeByDesc(result, desc, itemTypeFromId(id));
      }

      // For merges: just remove the source items; target is already in cleaned
      for (const ids of acceptedMerged) {
        for (let i = 1; i < ids.length; i++) {
          const srcDesc = findItemDesc(pending.oldProfileData, ids[i] ?? "");
          if (srcDesc) removeByDesc(result, srcDesc, itemTypeFromId(ids[i] ?? ""));
        }
      }

      // Restore source items from unapproved merges
      const acceptedTargetIds = new Set(acceptedMerged.map((g) => g[0]));
      for (const groupIds of pending.allMergedIds || []) {
        if (groupIds.length <= 1) continue;
        if (acceptedTargetIds.has(groupIds[0])) continue;
        for (let i = 1; i < groupIds.length; i++) {
          const srcId = groupIds[i] ?? "";
          if (!srcId) continue;
          const srcDesc = findItemDesc(pending.oldProfileData, srcId);
          if (!srcDesc) continue;
          const srcItem = findItemByDesc(pending.oldProfileData, srcDesc);
          if (srcItem) {
            const { id: _id, ...rest } = srcItem as any;
            if (srcId.startsWith("pref_")) result.preferences.push(rest);
            else if (srcId.startsWith("pat_")) result.patterns.push(rest);
            else if (srcId.startsWith("wf_")) result.workflows.push(rest);
          }
        }
      }

      // Restore items from unapproved removals
      const acceptedRemovedSet = new Set(acceptedRemoved);
      for (const removedId of pending.allRemovedIds || []) {
        if (acceptedRemovedSet.has(removedId)) continue;
        const desc = findItemDesc(pending.oldProfileData, removedId);
        if (!desc) continue;
        const srcItem = findItemByDesc(pending.oldProfileData, desc);
        if (srcItem) {
          const { id: _id, ...rest } = srcItem as any;
          if (removedId.startsWith("pref_")) result.preferences.push(rest);
          else if (removedId.startsWith("pat_")) result.patterns.push(rest);
          else if (removedId.startsWith("wf_")) result.workflows.push(rest);
        }
      }

      const success = await userProfileManager.updateProfile(
        profile.id,
        result,
        0,
        "AI cleanup applied (partial)"
      );
      if (!success)
        return { success: false, error: "Profile was modified by another session. Please retry." };
      pendingCleanups.delete(targetUserId);
      return {
        success: true,
        data: { message: "Partial cleanup applied", version: profile.version + 1 },
      };
    }

    const success = await userProfileManager.updateProfile(
      profile.id,
      cleanedData,
      0,
      "AI cleanup applied"
    );

    if (!success) {
      return { success: false, error: "Profile was modified by another session. Please retry." };
    }

    pendingCleanups.delete(targetUserId);

    return {
      success: true,
      data: { message: "Cleanup applied successfully", version: profile.version + 1 },
    };
  } catch (error) {
    log("handleApplyCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

function itemTypeFromId(id: string): string {
  if (id.startsWith("pref_")) return "preferences";
  if (id.startsWith("pat_")) return "patterns";
  return "workflows";
}
function findItemDesc(profile: UserProfileData, id: string): string | null {
  if (typeof id !== "string" || !id.includes("_")) return null;
  const parts = id.split("_");
  const prefix = parts[0];
  const idx = parseInt(parts[1] || "", 10);
  if (isNaN(idx)) return null;

  if (prefix === "pref") return profile.preferences[idx]?.description || null;
  if (prefix === "pat") return profile.patterns[idx]?.description || null;
  if (prefix === "wf") return profile.workflows[idx]?.description || null;

  return null;
}
function findItemByDesc(profile: UserProfileData, desc: string): any | null {
  for (const key of ["preferences", "patterns", "workflows"] as const) {
    const found = (profile as any)[key].find((p: any) => p.description === desc);
    if (found) return found;
  }
  return null;
}
function removeByDesc(profile: UserProfileData, desc: string, itemType?: string) {
  if (!itemType || itemType === "preferences") {
    profile.preferences = profile.preferences.filter((p) => p.description !== desc);
  }
  if (!itemType || itemType === "patterns") {
    profile.patterns = profile.patterns.filter((p) => p.description !== desc);
  }
  if (!itemType || itemType === "workflows") {
    profile.workflows = profile.workflows.filter((w) => w.description !== desc);
  }
}

export async function handleUpdateProfileItem(body?: any): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    const tags = getTags(process.cwd());
    const userId = tags.user.userEmail || "unknown";
    if (!userId) return { success: false, error: "Unable to resolve user identity" };

    const profile = await userProfileManager.getActiveProfile(userId);
    if (!profile) return { success: false, error: "No profile found" };

    const { type, index, action, category, description, steps } = body || {};
    if (!type || index === undefined || !action) {
      return { success: false, error: "type, index, and action are required" };
    }
    if (!["preferences", "patterns", "workflows"].includes(type)) {
      return { success: false, error: "type must be preferences, patterns, or workflows" };
    }
    if (!["edit", "delete"].includes(action)) {
      return { success: false, error: "action must be edit or delete" };
    }

    const profileData: UserProfileData = JSON.parse(profile.profileData);
    const items: any[] = (profileData as any)[type] || [];
    // Re-sort to match handleGetUserProfile's display order
    const metric = type === "preferences" ? "confidence" : "frequency";
    const sorted = sortProfileItems(items as any[], metric);

    if (index < 0 || index >= sorted.length) {
      return { success: false, error: "index out of range" };
    }

    if (action === "delete") {
      sorted.splice(index, 1);
    } else {
      const item = sorted[index];
      if (!item) return { success: false, error: "Item not found" };
      if (category !== undefined && type !== "workflows") item.category = category;
      if (description !== undefined && description !== item.description) {
        item.description = description;
        item.centroid = undefined;
        item.anchor = undefined;
      }
      if (steps !== undefined && Array.isArray(steps) && type === "workflows") item.steps = steps;
    }

    (profileData as any)[type] = sorted;

    const changeSummary =
      action === "delete"
        ? `Deleted ${type.slice(0, -1)} at index ${index}`
        : `Edited ${type.slice(0, -1)} at index ${index}`;

    const success = await userProfileManager.updateProfile(
      profile.id,
      profileData,
      0,
      changeSummary
    );
    if (!success)
      return { success: false, error: "Profile was modified by another session. Please retry." };

    return {
      success: true,
      data: { message: `${action} successful`, version: profile.version + 1 },
    };
  } catch (error) {
    log("handleUpdateProfileItem: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectTagMigration(): Promise<
  ApiResponse<{ needsMigration: boolean; count: number }>
> {
  try {
    await ensureTursoReady();
    const projectShards = await tursoShardManager.getAllShards("project", "");
    let untaggedCount = 0;
    for (const shard of projectShards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const row = await db.get(
        "SELECT COUNT(*) as count FROM memories WHERE tags IS NULL OR tags = ''"
      );
      untaggedCount += Number(row?.count ?? 0);
    }
    return { success: true, data: { needsMigration: untaggedCount > 0, count: untaggedCount } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

interface MigrationProgress {
  processed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  isComplete: boolean;
  errors: string[];
}

let migrationProgress: MigrationProgress = {
  processed: 0,
  total: 0,
  currentBatch: 0,
  totalBatches: 0,
  isComplete: true,
  errors: [],
};

export async function handleGetTagMigrationProgress(): Promise<ApiResponse<MigrationProgress>> {
  return { success: true, data: migrationProgress };
}

export async function handleRunTagMigrationBatch(
  batchSize: number = 5
): Promise<ApiResponse<{ processed: number; total: number; hasMore: boolean }>> {
  try {
    await ensureTursoReady();
    const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
    const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
    const providerConfig = buildMemoryProviderConfig(CONFIG, {
      maxIterations: 1,
      iterationTimeout: 30000,
    });
    const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);
    const projectShards = await tursoShardManager.getAllShards("project", "");

    let batchProcessed = 0;
    const allMemories: { memory: any; shard: any }[] = [];

    for (const shard of projectShards) {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const memories = await db.all("SELECT * FROM memories");
      for (const m of memories) {
        allMemories.push({ memory: m, shard });
      }
    }

    if (migrationProgress.total === 0) {
      migrationProgress.total = allMemories.length;
      migrationProgress.totalBatches = Math.ceil(allMemories.length / batchSize);
      migrationProgress.isComplete = false;
    }

    const startIdx = migrationProgress.processed;
    const endIdx = Math.min(startIdx + batchSize, allMemories.length);

    for (let i = startIdx; i < endIdx; i++) {
      const item = allMemories[i];
      if (!item) continue;
      const { memory: m, shard } = item;
      const db = await tursoConnectionManager.getConnection(shard.dbPath);

      try {
        let currentTags = m.tags
          ? m.tags
              .split(",")
              .map((t: string) => t.trim().toLowerCase())
              .filter((t: string) => t)
          : [];

        if (currentTags.length === 0) {
          const prompt = `Generate 2-4 short technical tags for this memory content:\n\n${m.content}\n\nReturn ONLY a comma-separated list of tags.`;
          const result = await provider.executeToolCall(
            "You are a technical tagger.",
            prompt,
            {
              type: "function",
              function: {
                name: "save_tags",
                description: "Save generated tags",
                parameters: {
                  type: "object",
                  properties: { tags: { type: "array", items: { type: "string" } } },
                  required: ["tags"],
                },
              },
            },
            `migration_${m.id}`
          );
          if (result.success && result.data?.tags) {
            currentTags = result.data.tags;
            await db.run("UPDATE memories SET tags = ? WHERE id = ?", [
              currentTags.join(","),
              m.id,
            ]);
          }
        }

        const vector = await embeddingService.embedWithTimeout(m.content);
        const tagsVector = currentTags.length
          ? await embeddingService.embedWithTimeout(formatTagsForEmbedding(currentTags))
          : undefined;
        await tursoVectorSearch.updateVector(db, m.id, vector, tagsVector);

        migrationProgress.processed++;
        batchProcessed++;
      } catch (e) {
        const errorMsg = String(e);
        migrationProgress.errors.push(errorMsg);
        log("Migration error for memory", { id: m.id, error: errorMsg });
      }
    }

    migrationProgress.currentBatch++;
    const hasMore = migrationProgress.processed < migrationProgress.total;

    if (!hasMore) {
      migrationProgress.isComplete = true;
    }

    return {
      success: true,
      data: { processed: migrationProgress.processed, total: migrationProgress.total, hasMore },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
