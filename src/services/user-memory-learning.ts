import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "./client.js";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import type { UserPrompt } from "./user-prompt/user-prompt-manager.js";

export async function performUserMemoryLearning(
  ctx: PluginInput,
  directory: string
): Promise<void> {
  try {
    const count = userPromptManager.countUnanalyzedForUserLearning();
    const threshold = CONFIG.userMemoryAnalysisInterval;

    if (count < threshold) {
      return;
    }

    const prompts = userPromptManager.getPromptsForUserLearning(threshold);

    if (prompts.length === 0) {
      return;
    }

    const context = buildUserAnalysisContext(prompts);

    const memories = await analyzeUserPatterns(ctx, context);

    if (!memories || memories.length === 0) {
      log("User memory learning: no patterns identified", { promptCount: prompts.length });
      userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
      return;
    }

    const tags = getTags(directory);
    let savedCount = 0;

    for (const memory of memories) {
      const result = await memoryClient.addMemory(memory.summary, tags.user.tag, {
        type: memory.type,
        source: "user-learning" as any,
        promptCount: prompts.length,
        analysisTimestamp: Date.now(),
        reasoning: memory.reasoning,
        displayName: tags.user.displayName,
        userName: tags.user.userName,
        userEmail: tags.user.userEmail,
      });

      if (result.success) {
        savedCount++;
      }
    }

    userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));

    if (savedCount > 0) {
      await ctx.client?.tui
        .showToast({
          body: {
            title: "User Memory Learning",
            message: `Learned ${savedCount} pattern${savedCount > 1 ? "s" : ""} from ${prompts.length} prompts`,
            variant: "success",
            duration: 3000,
          },
        })
        .catch(() => {});
    }
  } catch (error) {
    log("User memory learning error", { error: String(error) });

    await ctx.client?.tui
      .showToast({
        body: {
          title: "User Memory Learning Failed",
          message: String(error),
          variant: "error",
          duration: 5000,
        },
      })
      .catch(() => {});
  }
}

function buildUserAnalysisContext(prompts: UserPrompt[]): string {
  return `# User Prompt History Analysis

Analyze the following ${prompts.length} user prompts to identify patterns, preferences, and workflows.

## Prompts

${prompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n\n")}

## Analysis Instructions

Identify user patterns and preferences from these prompts. Look for:

1. **Preferences**: How the user likes things done
   - Code style preferences (e.g., "prefers code without comments")
   - Communication preferences (e.g., "likes concise responses")
   - Tool preferences (e.g., "prefers TypeScript over JavaScript")

2. **Patterns**: Recurring topics or requests
   - Technical topics (e.g., "often asks about database optimization")
   - Problem domains (e.g., "frequently works on authentication")
   - Skill level indicators (e.g., "asks detailed questions about async patterns")

3. **Workflows**n sequences or habits
   - Development flow (e.g., "usually asks for tests after implementation")
   - Review habits (e.g., "always requests code review before committing")
   - Learning style (e.g., "prefers examples over explanations")

Generate 1-5 key insights as memories. Only include patterns that are clearly evident from multiple prompts.`;
}

async function analyzeUserPatterns(
  ctx: PluginInput,
  context: string
): Promise<Array<{ summary: string; type: string; reasoning?: string }>> {
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl || !CONFIG.memoryApiKey) {
    throw new Error("External API not configured for user memory learning");
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");

  const providerConfig = {
    model: CONFIG.memoryModel,
    apiUrl: CONFIG.memoryApiUrl,
    apiKey: CONFIG.memoryApiKey,
    maxIterations: CONFIG.autoCaptureMaxIterations,
    iterationTimeout: CONFIG.autoCaptureIterationTimeout,
  };

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const systemPrompt = `You are a user behavior analyst for a coding assistant.

Your task is to analyze user prompts fy patterns, preferences, and workflows.

Use the save_user_memories tool to save identified patterns. Only save patterns that are clearly evident from the prompts.`;

  const toolSchema = {
    type: "function" as const,
    function: {
      name: "save_user_memories",
      description: "Save identified user patterns and preferences",
      parameters: {
        type: "object",
        properties: {
          memories: {
            type: "array",
            description: "Array of identified patterns (1-5 memories)",
            items: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  description: "Clear description of the pattern or preference",
                },
                type: {
                  type: "string",
                  description:
                    "Type of insight (e.g., preference, pattern, workflow, skill-level, communication-style)",
                },
                reasoning: {
                  type: "string",
                  description: "Why this pattern is significant (optial)",
                },
              },
              required: ["summary", "type"],
            },
          },
        },
        required: ["memories"],
      },
    },
  };

  const result = await provider.executeToolCall(systemPrompt, context, toolSchema, "user-learning");

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to analyze user patterns");
  }

  return result.data.memories || [];
}
