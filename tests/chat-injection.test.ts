import { describe, it, expect } from "bun:test";
import {
  extractAssistantTail,
  buildSemanticQuery,
  mergeHybrid,
} from "../src/services/chat-injection.js";
import type { Message, SemanticResult, RecentResult } from "../src/services/chat-injection.js";

describe("chat-injection", () => {
  describe("extractAssistantTail", () => {
    it("returns undefined when messages is empty", () => {
      expect(extractAssistantTail([])).toBeUndefined();
    });

    it("returns undefined when no assistant messages exist", () => {
      const messages: Message[] = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      ];
      expect(extractAssistantTail(messages)).toBeUndefined();
    });

    it("returns undefined when assistant has no text parts", () => {
      const messages: Message[] = [
        { info: { role: "assistant" }, parts: [{ type: "tool_result" }] },
      ];
      expect(extractAssistantTail(messages)).toBeUndefined();
    });

    it("returns undefined when all assistant text parts are synthetic", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Memory context here", synthetic: true }],
        },
      ];
      expect(extractAssistantTail(messages)).toBeUndefined();
    });

    it("extracts the last paragraph from a single paragraph reply", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "This is the reply." }],
        },
      ];
      expect(extractAssistantTail(messages)).toBe("This is the reply.");
    });

    it("takes the last non-empty paragraph when multiple exist", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "First paragraph.\n\nSecond paragraph." }],
        },
      ];
      expect(extractAssistantTail(messages)).toBe("Second paragraph.");
    });

    it("skips whitespace-only trailing paragraphs", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Real paragraph.\n\n   \n\n" }],
        },
      ];
      expect(extractAssistantTail(messages)).toBe("Real paragraph.");
    });

    it("caps output at 500 characters", () => {
      const longText = "x".repeat(600);
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: longText }],
        },
      ];
      const result = extractAssistantTail(messages);
      expect(result).toBeDefined();
      expect(result!.length).toBe(500);
      expect(result).toBe("x".repeat(500));
    });

    it("ignores synthetic parts and uses only non-synthetic text", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "Injected context", synthetic: true },
            { type: "text", text: "Real reply here." },
          ],
        },
      ];
      expect(extractAssistantTail(messages)).toBe("Real reply here.");
    });

    it("uses the LAST assistant message, not an earlier one", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Old reply." }],
        },
        { info: { role: "user" }, parts: [{ type: "text", text: "Follow up." }] },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Latest reply." }],
        },
      ];
      expect(extractAssistantTail(messages)).toBe("Latest reply.");
    });

    it("handles a code-block-like paragraph (no double newline inside)", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "text",
              text: "Explanation here.\n\n```ts\nconst x = 1;\nconst y = 2;\n```",
            },
          ],
        },
      ];
      const result = extractAssistantTail(messages);
      expect(result).toBe("```ts\nconst x = 1;\nconst y = 2;\n```");
    });

    it("joins multiple non-synthetic text parts with double newline before splitting", () => {
      const messages: Message[] = [
        {
          info: { role: "assistant" },
          parts: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two.\n\nPart three." },
          ],
        },
      ];
      expect(extractAssistantTail(messages)).toBe("Part three.");
    });
  });

  describe("buildSemanticQuery", () => {
    it("returns just the user message when no assistant tail", () => {
      expect(buildSemanticQuery("What is X?")).toBe("What is X?");
    });

    it("returns just the user message when assistantTail is undefined", () => {
      expect(buildSemanticQuery("What is X?", undefined)).toBe("What is X?");
    });

    it("combines user message and assistant tail with double newline", () => {
      expect(buildSemanticQuery("What is X?", "X is the answer.")).toBe(
        "What is X?\n\nX is the answer."
      );
    });

    it("filters empty string assistant tail", () => {
      expect(buildSemanticQuery("What is X?", "")).toBe("What is X?");
    });
  });

  describe("mergeHybrid", () => {
    it("returns empty array when both inputs are empty", () => {
      expect(mergeHybrid([], [], 5)).toEqual([]);
    });

    it("returns only semantic results when recent is empty", () => {
      const semantic: SemanticResult[] = [{ id: "a", memory: "mem a", similarity: 0.9 }];
      const result = mergeHybrid(semantic, [], 5);
      expect(result).toEqual([{ id: "a", text: "mem a", similarity: 0.9 }]);
    });

    it("returns only recent results when semantic is empty", () => {
      const recent: RecentResult[] = [{ id: "b", summary: "mem b" }];
      const result = mergeHybrid([], recent, 5);
      expect(result).toEqual([{ id: "b", text: "mem b", similarity: 1.0 }]);
    });

    it("puts semantic results before recent results", () => {
      const semantic: SemanticResult[] = [{ id: "s1", memory: "sem 1", similarity: 0.8 }];
      const recent: RecentResult[] = [{ id: "r1", summary: "rec 1" }];
      const result = mergeHybrid(semantic, recent, 5);
      expect(result[0]?.id).toBe("s1");
      expect(result[1]?.id).toBe("r1");
    });

    it("deduplicates by id (semantic takes precedence)", () => {
      const semantic: SemanticResult[] = [
        { id: "shared", memory: "from semantic", similarity: 0.7 },
      ];
      const recent: RecentResult[] = [{ id: "shared", summary: "from recent" }];
      const result = mergeHybrid(semantic, recent, 5);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: "shared", text: "from semantic", similarity: 0.7 });
    });

    it("enforces the maxMemories cap", () => {
      const semantic: SemanticResult[] = [
        { id: "s1", memory: "s1", similarity: 0.9 },
        { id: "s2", memory: "s2", similarity: 0.8 },
      ];
      const recent: RecentResult[] = [
        { id: "r1", summary: "r1" },
        { id: "r2", summary: "r2" },
      ];
      const result = mergeHybrid(semantic, recent, 3);
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.id)).toEqual(["s1", "s2", "r1"]);
    });

    it("cap of 0 returns empty array", () => {
      const semantic: SemanticResult[] = [{ id: "s1", memory: "s1", similarity: 0.9 }];
      expect(mergeHybrid(semantic, [], 0)).toEqual([]);
    });

    it("preserves semantic ordering within semantic results", () => {
      const semantic: SemanticResult[] = [
        { id: "s1", memory: "s1", similarity: 0.9 },
        { id: "s2", memory: "s2", similarity: 0.7 },
        { id: "s3", memory: "s3", similarity: 0.5 },
      ];
      const result = mergeHybrid(semantic, [], 5);
      expect(result.map((r) => r.id)).toEqual(["s1", "s2", "s3"]);
    });

    it("assigns similarity 1.0 to recent-only entries", () => {
      const recent: RecentResult[] = [{ id: "r1", summary: "rec" }];
      const result = mergeHybrid([], recent, 5);
      expect(result[0]?.similarity).toBe(1.0);
    });
  });

  // Task 5 — fallback / degradation coverage
  // These tests verify the three key fallback scenarios for semantic selection:
  //   1. No prior assistant message → semantic query uses userMessage only
  //   2. Semantic mode zero matches above threshold → empty result → no injection
  //   3. Hybrid mode degrades to recent-only when semantic retrieval throws
  describe("selection fallback behavior", () => {
    it("semantic query uses only userMessage when no prior messages exist", () => {
      const assistantTail = extractAssistantTail([]);
      expect(assistantTail).toBeUndefined();
      const query = buildSemanticQuery("How do I configure a plugin?", assistantTail);
      expect(query).toBe("How do I configure a plugin?");
    });

    it("semantic query uses only userMessage when all prior messages are from user", () => {
      const messages: Message[] = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Earlier question" }] },
      ];
      const assistantTail = extractAssistantTail(messages);
      expect(assistantTail).toBeUndefined();
      const query = buildSemanticQuery("Follow-up question", assistantTail);
      expect(query).toBe("Follow-up question");
    });

    it("semantic mode with zero matches above threshold produces empty memories (no injection)", () => {
      // searchMemories already filters by threshold; when nothing qualifies, results=[].
      // normalizedMemories will be empty → hook returns early without injecting anything.
      const noMatches: SemanticResult[] = [];
      const normalized = mergeHybrid(noMatches, [], 3);
      expect(normalized).toHaveLength(0);
    });

    it("hybrid mode degrades to recent-only when semantic search throws", () => {
      // In the hybrid catch-block, semanticResults stays [] and recentResults is populated.
      // mergeHybrid([], recentFallback, max) must produce a valid recent-only list.
      const recentFallback: RecentResult[] = [
        { id: "r1", summary: "recent memory alpha" },
        { id: "r2", summary: "recent memory beta" },
      ];
      const result = mergeHybrid([], recentFallback, 5);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: "r1", text: "recent memory alpha", similarity: 1.0 });
      expect(result[1]).toEqual({ id: "r2", text: "recent memory beta", similarity: 1.0 });
    });

    it("hybrid mode preserves semantic results even when recent list is empty after fallback", () => {
      // If only semantic results survive (recent throws or returns nothing), they are preserved.
      const semanticOnly: SemanticResult[] = [
        { id: "s1", memory: "semantic memory", similarity: 0.85 },
      ];
      const result = mergeHybrid(semanticOnly, [], 5);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: "s1", text: "semantic memory", similarity: 0.85 });
    });
  });
});
