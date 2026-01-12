import type { PluginInput } from "@opencode-ai/plugin";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import type { UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { userProfileManager } from "./user-profile/user-profile-manager.js";
import type { UserProfile, UserProfileData } from "./user-profile/types.js";

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

    const tags = getTags(directory);
    const userId = tags.user.userEmail || "unknown";

    const existingProfile = userProfileManager.getActiveProfile(userId);

    const context = buildUserAnalysisContext(prompts, existingProfile);

    const updatedProfileData = await analyzeUserProfile(context, existingProfile);

    if (!updatedProfileData) {
      log("User memory learning: no profile updates", { promptCount: prompts.length });
      userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
      return;
    }

    if (existingProfile) {
      const changeSummary = generateChangeSummary(
        JSON.parse(existingProfile.profileData),
        updatedProfileData
      );
      userProfileManager.updateProfile(
        existingProfile.id,
        updatedProfileData,
        prompts.length,
        changeSummary
      );
    } else {
      userProfileManager.createProfile(
        userId,
        tags.user.displayName || "Unknown",
        tags.user.userName || "unknown",
        tags.user.userEmail || "unknown",
        updatedProfileData,
        prompts.length
      );
    }

    userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));

    await ctx.client?.tui
      .showToast({
        body: {
          title: "User Profile Updated",
          message: `Analyzed ${prompts.length} prompts and updated your profile`,
          variant: "success",
          duration: 3000,
        },
      })
      .catch(() => {});
  } catch (error) {
    log("User memory learning error", { error: String(error) });

    await ctx.client?.tui
      .showToast({
        body: {
          title: "User Profile Update Failed",
          message: String(error),
          variant: "error",
          duration: 5000,
        },
      })
      .catch(() => {});
  }
}

function generateChangeSummary(oldProfile: UserProfileData, newProfile: UserProfileData): string {
  const changes: string[] = [];

  const prefDiff = newProfile.preferences.length - oldProfile.preferences.length;
  if (prefDiff > 0) changes.push(`+${prefDiff} preferences`);

  const patternDiff = newProfile.patterns.length - oldProfile.patterns.length;
  if (patternDiff > 0) changes.push(`+${patternDiff} patterns`);

  const workflowDiff = newProfile.workflows.length - oldProfile.workflows.length;
  if (workflowDiff > 0) changes.push(`+${workflowDiff} workflows`);

  return changes.length > 0 ? changes.join(", ") : "Profile refinement";
}

function buildUserAnalysisContext(
  prompts: UserPrompt[],
  existingProfile: UserProfile | null
): string {
  const existingProfileSection = existingProfile
    ? `
## Existing User Profile

${existingProfile.profileData}

**Instructions**: Merge new insights with the existing profile. Update confidence scores for reinforced patterns, add new patterns, and refine existing ones.`
    : `
**Instructions**: Create a new user profile from scratch based on the prompts below.`;

  return `# User Profile Analysis

Analyze ${prompts.length} user prompts to ${existingProfile ? "update" : "create"} the user profile.

${existingProfileSection}

## Recent Prompts

${prompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n\n")}

## Analysis Guidelines

Identify and ${existingProfile ? "update" : "create"}:

1. **Preferences** (max ${CONFIG.userProfileMaxPreferences})
   - Code style, communication style, tool preferences
   - Assign confidence 0.5-1.0 based on evidence strength
   - Include 1-3 example prompts as evidence

2. **Patterns** (max ${CONFIG.userProfileMaxPatterns})
   - Recurring topics, problem domains, technical interests
   - Track frequency of occurrence

3. **Workflows** (max ${CONFIG.userProfileMaxWorkflows})
   - Development sequences, habits, learning style
   - Break down into steps if applicable

4. **Skill Level**
   - Overall: beginner/intermediate/advanced
   - Per-domain assessment (e.g., typescript: advanced, docker: beginner)

${existingProfile ? "Merge with existing profile, incrementing frequencies and updating confidence scores." : "Create initial profile with conservative confidence scores."}`;
}

async function analyzeUserProfile(
  context: string,
  existingProfile: UserProfile | null
): Promise<UserProfileData | null> {
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

Your task is to analyze user prompts and ${existingProfile ? "update" : "create"} a comprehensive user profile.

Use the update_user_profile tool to save the ${existingProfile ? "updated" : "new"} profile.`;

  const toolSchema = {
    type: "function" as const,
    function: {
      name: "update_user_profile",
      description: existingProfile
        ? "Update existing user profile with new insights"
        : "Create new user profile",
      parameters: {
        type: "object",
        properties: {
          preferences: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: { type: "string" },
                description: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                evidence: { type: "array", items: { type: "string" }, maxItems: 3 },
              },
              required: ["category", "description", "confidence", "evidence"],
            },
          },
          patterns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: { type: "string" },
                description: { type: "string" },
              },
              required: ["category", "description"],
            },
          },
          workflows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                steps: { type: "array", items: { type: "string" } },
              },
              required: ["description", "steps"],
            },
          },
          skillLevel: {
            type: "object",
            properties: {
              overall: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
              domains: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["overall", "domains"],
          },
        },
        required: ["preferences", "patterns", "workflows", "skillLevel"],
      },
    },
  };

  const result = await provider.executeToolCall(systemPrompt, context, toolSchema, "user-profile");

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to analyze user profile");
  }

  const rawData = result.data;

  if (existingProfile) {
    const existingData: UserProfileData = JSON.parse(existingProfile.profileData);
    return userProfileManager.mergeProfileData(existingData, rawData);
  }

  return rawData as UserProfileData;
}
