import Supermemory from "supermemory";
import { CONFIG, SUPERMEMORY_API_KEY, isConfigured } from "../config.js";
import { log } from "./logger.js";
import type {
  MemoryType,
  ConversationMessage,
  ConversationIngestResponse,
} from "../types/index.js";

const SUPERMEMORY_API_URL = "https://api.supermemory.ai";

const TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export class SupermemoryClient {
  private client: Supermemory | null = null;

  private getClient(): Supermemory {
    if (!this.client) {
      if (!isConfigured()) {
        throw new Error("SUPERMEMORY_API_KEY not set");
      }
      this.client = new Supermemory({ apiKey: SUPERMEMORY_API_KEY });
    }
    return this.client;
  }

  async searchMemories(query: string, containerTag: string) {
    log("searchMemories: start", { containerTag });
    try {
      const result = await withTimeout(
        this.getClient().search.memories({
          q: query,
          containerTag,
          threshold: CONFIG.similarityThreshold,
          limit: CONFIG.maxMemories,
          rerank: true,
        }),
        TIMEOUT_MS
      );
      log("searchMemories: success", { count: result.results?.length || 0 });
      return result;
    } catch (error) {
      log("searchMemories: error", { error: String(error) });
      console.error("Supermemory: search failed", error);
      return { results: [], total: 0, timing: 0 };
    }
  }

  async getProfile(containerTag: string, query?: string) {
    log("getProfile: start", { containerTag });
    try {
      const result = await withTimeout(
        this.getClient().profile({
          containerTag,
          q: query,
        }),
        TIMEOUT_MS
      );
      log("getProfile: success", { hasProfile: !!result?.profile });
      return result;
    } catch (error) {
      log("getProfile: error", { error: String(error) });
      console.error("Supermemory: profile fetch failed", error);
      return null;
    }
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: { type?: MemoryType; tool?: string; [key: string]: unknown }
  ) {
    try {
      return await withTimeout(
        this.getClient().memories.add({
          content,
          containerTag,
          metadata: metadata as Record<string, string | number | boolean | string[]>,
        }),
        TIMEOUT_MS
      );
    } catch (error) {
      console.error("Supermemory: add memory failed", error);
      return null;
    }
  }

  async forgetMemory(containerTag: string, memoryId?: string) {
    try {
      return await withTimeout(
        this.getClient().memories.forget({
          containerTag,
          id: memoryId,
        }),
        TIMEOUT_MS
      );
    } catch (error) {
      console.error("Supermemory: forget memory failed", error);
      return null;
    }
  }

  async listMemories(containerTag: string, limit = 20) {
    log("listMemories: start", { containerTag, limit });
    try {
      const result = await withTimeout(
        this.getClient().memories.list({
          containerTags: [containerTag],
          limit,
          order: "desc",
          sort: "createdAt",
        }),
        TIMEOUT_MS
      );
      log("listMemories: success", { count: result.memories?.length || 0 });
      return result;
    } catch (error) {
      log("listMemories: error", { error: String(error) });
      console.error("Supermemory: list memories failed", error);
      return { memories: [], pagination: { currentPage: 1, totalItems: 0, totalPages: 0 } };
    }
  }

  async ingestConversation(
    conversationId: string,
    messages: ConversationMessage[],
    containerTags: string[],
    metadata?: Record<string, string | number | boolean>
  ): Promise<ConversationIngestResponse | null> {
    log("ingestConversation: start", { conversationId, messageCount: messages.length });
    try {
      const response = await withTimeout(
        fetch(`${SUPERMEMORY_API_URL}/conversations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPERMEMORY_API_KEY}`,
          },
          body: JSON.stringify({
            conversationId,
            messages,
            containerTags,
            metadata,
          }),
        }),
        TIMEOUT_MS
      );

      if (!response.ok) {
        const errorText = await response.text();
        log("ingestConversation: error response", { status: response.status, error: errorText });
        return null;
      }

      const result = await response.json() as ConversationIngestResponse;
      log("ingestConversation: success", { conversationId, status: result.status });
      return result;
    } catch (error) {
      log("ingestConversation: error", { error: String(error) });
      console.error("Supermemory: ingest conversation failed", error);
      return null;
    }
  }
}

export const supermemoryClient = new SupermemoryClient();
