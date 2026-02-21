// src/services/team-knowledge/extractors/lesson-extractor.ts

import { BaseExtractor } from "./base-extractor.js";
import type { KnowledgeExtractResult } from "../../../types/team-knowledge.js";
import { memoryClient } from "../../client.js";
import { CONFIG } from "../../../config.js";
import { log } from "../../logger.js";

export class LessonExtractor extends BaseExtractor {
  readonly type = "lesson" as const;
  readonly sourceType = "conversation" as const;

  async extract(directory: string): Promise<KnowledgeExtractResult> {
    const items: KnowledgeExtractResult["items"] = [];
    const errors: string[] = [];

    // Skip if AI not configured
    if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
      return { items, errors };
    }

    try {
      const { getTags } = await import("../../tags.js");
      const tags = getTags(directory);

      // Get recent memories
      const memoriesResult = await memoryClient.listMemories(tags.project.tag, 50);

      if (!memoriesResult.success || memoriesResult.memories.length === 0) {
        return { items, errors };
      }

      // Filter for relevant types
      const relevantMemories = memoriesResult.memories.filter((m) => {
        const metadata = m.metadata || {};
        return (
          metadata.type === "bug-fix" ||
          metadata.type === "discussion" ||
          m.summary?.toLowerCase().includes("fix") ||
          m.summary?.toLowerCase().includes("bug") ||
          m.summary?.toLowerCase().includes("issue")
        );
      });

      if (relevantMemories.length < 3) {
        return { items, errors };
      }

      // Use AI to extract lessons
      const lessons = await this.extractLessonsWithAI(relevantMemories);
      items.push(...lessons);
    } catch (e) {
      errors.push(`Lesson extraction failed: ${e}`);
      log("Lesson extraction error", { error: String(e) });
    }

    return { items, errors };
  }

  private async extractLessonsWithAI(
    memories: Array<{
      id: string;
      summary: string;
      createdAt: string;
      metadata?: Record<string, unknown>;
      displayName?: string;
      userName?: string;
      userEmail?: string;
      projectPath?: string;
      projectName?: string;
      gitRepoUrl?: string;
    }>
  ): Promise<KnowledgeExtractResult["items"]> {
    const { AIProviderFactory } = await import("../../ai/ai-provider-factory.js");

    const providerConfig = {
      model: CONFIG.memoryModel!,
      apiUrl: CONFIG.memoryApiUrl!,
      apiKey: CONFIG.memoryApiKey,
      maxIterations: 1,
      iterationTimeout: CONFIG.autoCaptureIterationTimeout,
    };

    const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

    const memorySummaries = memories
      .slice(0, 20)
      .map((m, i) => `${i + 1}. ${m.summary}`)
      .join("\n");

    const systemPrompt = `You are a technical knowledge curator. Analyze bug fixes and discussions to extract reusable lessons learned.

OUTPUT FORMAT (JSON):
{
  "lessons": [
    {
      "title": "Short title (max 60 chars)",
      "content": "Lesson description in Markdown (2-4 sentences)",
      "tags": ["tag1", "tag2"]
    }
  ]
}

RULES:
1. Extract 2-5 distinct lessons from the memories
2. Focus on actionable, reusable knowledge
3. Be specific about technical context
4. Tags should be technical keywords`;

    const userPrompt = `Analyze these recent project memories and extract reusable lessons learned:

${memorySummaries}

Return JSON with extracted lessons.`;

    const toolSchema = {
      type: "function" as const,
      function: {
        name: "save_lessons",
        description: "Save extracted lessons",
        parameters: {
          type: "object",
          properties: {
            lessons: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  content: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                },
                required: ["title", "content", "tags"],
              },
            },
          },
          required: ["lessons"],
        },
      },
    };

    const result = await provider.executeToolCall(
      systemPrompt,
      userPrompt,
      toolSchema,
      "lesson-extraction"
    );

    if (!result.success || !result.data?.lessons) {
      return [];
    }

    return result.data.lessons.map(
      (lesson: { title: string; content: string; tags: string[] }, index: number) =>
        this.createItem(
          lesson.title,
          `## ${lesson.title}\n\n${lesson.content}`,
          "project-memories",
          lesson.tags.map((t: string) => t.toLowerCase()),
          0.75,
          `lesson-${index}`
        )
    );
  }
}

export const lessonExtractor = new LessonExtractor();
