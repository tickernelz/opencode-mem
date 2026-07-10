import type { PluginInput } from "@opencode-ai/plugin";
import { getTags } from "./tags.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import type { UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { userProfileManager } from "./user-profile/user-profile-manager.js";
import { sortProfileItems } from "../utils/profile.js";
import type { UserProfile, UserProfileData } from "./user-profile/types.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";

let isLearningRunning = false;

export async function performUserProfileLearning(
  ctx: PluginInput,
  directory: string
): Promise<void> {
  if (isLearningRunning) return;
  isLearningRunning = true;
  try {
    const count = userPromptManager.countUnanalyzedForUserLearning();
    const threshold = CONFIG.userProfileAnalysisInterval;

    log("user-profile-learning: check", { count, threshold });

    if (count < threshold) {
      return;
    }

    const prompts = userPromptManager.getPromptsForUserLearning(threshold);

    if (prompts.length === 0) {
      return;
    }

    const tags = getTags(directory);
    const userId = tags.user.userEmail || "unknown";

    let existingProfile = userProfileManager.getActiveProfile(userId);
    const analysisStartTime = Date.now();

    let validationPrompt: string | undefined;
    let validationPrefKeys: string[] | undefined;
    if (existingProfile && CONFIG.userProfileValidationEnabled) {
      const profileData: UserProfileData = JSON.parse(existingProfile.profileData);
      const { data: decayed } = userProfileManager.decayInMemory(profileData);

      for (const arr of [decayed.preferences, decayed.patterns, decayed.workflows] as any[][]) {
        for (const item of arr) {
          if (item.pendingValidation && (item.lastSeen || 0) < analysisStartTime) {
            item.pendingValidation = false;
            item.alpha = (item.alpha || 1) + 1;
            userProfileManager.syncConfidence(item);
          }
        }
      }

      existingProfile = { ...existingProfile, profileData: JSON.stringify(decayed) };

      const topPrefs = (
        sortProfileItems(decayed.preferences as any[], "confidence") as any[]
      ).slice(0, 5);
      const topPats = (sortProfileItems(decayed.patterns as any[], "frequency") as any[]).slice(
        0,
        3
      );
      const hasValidator = topPrefs.length >= 5;
      if (hasValidator) {
        const allValidated = [...topPrefs, ...topPats];
        validationPrefKeys = allValidated.map(
          (p: any) => `${p.category || "_"}||${(p.description || "").substring(0, 30)}`
        );
        log("user-profile-learning: validation enabled", {
          topPrefs: topPrefs.map(
            (p: any) => `[${p.category}] ${(p.description || "").substring(0, 30)}`
          ),
          topPats: topPats.map(
            (p: any) => `[${p.category}] ${(p.description || "").substring(0, 30)}`
          ),
        });
        validationPrompt = `## Task 3: Validate Existing Profile Entries

CRITICAL: Complete Tasks 1-2 (new observations) FIRST. This task is separate — only check whether the entries below still match recent behavior. Do NOT let these descriptions influence your new observations.

${allValidated.map((p: any, i: number) => `${i}. [${p.category || "_"}] ${(p.description || "").substring(0, 30)} (conf: ${Math.round((p.confidence || 0) * 100) / 100})`).join("\n")}

For each entry above, judge whether recent prompts confirm or contradict it. Output:
{"validations": [{"index": 0, "verdict": "confirmed|contradicted|no_evidence|inaccurate|oversimplified", "reason": "one sentence"}]}

Rules:
- confirmed: recent prompts show clear evidence
- contradicted: recent prompts show the user has changed
- inaccurate: the description is directionally wrong (opposite behavior seen)
- oversimplified: the description is too vague, missing important nuance
- no_evidence: recent prompts don't address this topic
- Only mark contradicted if there is explicit evidence the user's behavior has changed`;
      } else {
        log("user-profile-learning: validation skipped", {
          prefCount: topPrefs.length,
          reason: "needs ≥ 5 preferences",
        });
      }
    } else if (existingProfile) {
      const profileData: UserProfileData = JSON.parse(existingProfile.profileData);
      const { data: decayed } = userProfileManager.decayInMemory(profileData);

      for (const arr of [decayed.preferences, decayed.patterns, decayed.workflows] as any[][]) {
        for (const item of arr) {
          if (item.pendingValidation && (item.lastSeen || 0) < analysisStartTime) {
            item.pendingValidation = false;
            item.alpha = (item.alpha || 1) + 1;
            userProfileManager.syncConfidence(item);
          }
        }
      }

      existingProfile = { ...existingProfile, profileData: JSON.stringify(decayed) };
    }

    const context = buildUserAnalysisContext(prompts, existingProfile, validationPrompt);

    const analysisResult = await analyzeUserProfile(context, existingProfile);

    log("user-profile-learning: analyze done", { hasResult: !!analysisResult });

    if (!analysisResult) {
      userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
      if (prompts.length >= 10 && existingProfile) {
        buildLearningPaths(prompts, existingProfile.id).catch(() => {});
      }
      return;
    }

    const { raw: llmResult, merged: initialMerged } = analysisResult;

    if (existingProfile) {
      let updatedProfileData = initialMerged!;
      const MAX_RETRIES = 2;
      let retries = 0;
      let success = false;

      while (!success && retries <= MAX_RETRIES) {
        if (retries > 0) {
          existingProfile = userProfileManager.getActiveProfile(userId);
          if (!existingProfile) break;
          const retryProfileData: UserProfileData = JSON.parse(existingProfile.profileData);
          const { data: decayedRetry } = userProfileManager.decayInMemory(retryProfileData);
          existingProfile = { ...existingProfile, profileData: JSON.stringify(decayedRetry) };
          updatedProfileData = await userProfileManager.mergeProfileData(
            decayedRetry,
            llmResult,
            undefined,
            existingProfile.id
          );
          log("user-profile-learning: retry merge", {
            retry: retries,
            profileId: existingProfile.id,
          });
        }

        let changeSummary = generateChangeSummary(
          JSON.parse(existingProfile.profileData),
          updatedProfileData
        );

        const validationSummary = applyValidations(
          updatedProfileData,
          llmResult,
          existingProfile.id,
          validationPrefKeys
        );
        if (validationSummary) {
          changeSummary = changeSummary + "; " + validationSummary;
        }

        success = userProfileManager.updateProfile(
          existingProfile.id,
          updatedProfileData,
          prompts.length,
          changeSummary
        );
        if (!success) {
          log("User profile update conflict, retrying", {
            profileId: existingProfile.id,
            userId,
            retry: retries,
          });
        }
        retries++;
      }

      if (!success) {
        log("User profile update conflict: exhausted retries", {
          profileId: existingProfile?.id,
          userId,
        });
        return;
      }

      userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
    } else {
      userProfileManager.createProfile(
        userId,
        tags.user.displayName || "Unknown",
        tags.user.userName || "unknown",
        tags.user.userEmail || "unknown",
        llmResult,
        prompts.length
      );
      userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
    }

    if (CONFIG.showUserProfileToasts) {
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
    }
  } finally {
    isLearningRunning = false;
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

function buildCategorySummary(profileData: UserProfileData): string {
  const parts: string[] = [];

  const prefCats = [...new Set(profileData.preferences.map((p) => p.category))];
  const patCats = [...new Set(profileData.patterns.map((p) => p.category))];

  const catParts: string[] = [];
  if (prefCats.length > 0) {
    const catCounts = prefCats
      .map((cat) => {
        const cnt = profileData.preferences.filter((p) => p.category === cat).length;
        return `${cat} (${cnt})`;
      })
      .join(", ");
    catParts.push(`Preference categories: ${catCounts}`);
  }
  if (patCats.length > 0) {
    const catCounts = patCats
      .map((cat) => {
        const cnt = profileData.patterns.filter((p) => p.category === cat).length;
        return `${cat} (${cnt})`;
      })
      .join(", ");
    catParts.push(`Pattern categories: ${catCounts}`);
  }

  const catSection =
    catParts.length > 0
      ? `## Existing Categories\nUse these exact category names when your observation fits:\n\n${catParts.join("\n")}\n`
      : "";

  const prefCount = profileData.preferences.length;
  const patCount = profileData.patterns.length;
  const wfCount = profileData.workflows.length;

  const wfParts: string[] = [];
  if (wfCount > 0) {
    wfParts.push(
      "## Existing Workflows\nFor reference — only report a workflow when recent prompts show a genuinely NEW sequence, NOT a minor variant of an existing one:"
    );
    profileData.workflows.forEach((wf, i) => {
      const steps = wf.steps?.length
        ? ` (freq ${wf.frequency || 1}x: ${wf.steps.join(" → ")})`
        : "";
      wfParts.push(`${i + 1}. ${wf.description}${steps}`);
    });
  }

  const countSection = `## Profile Size\nPreferences: ${prefCount} | Patterns: ${patCount} | Workflows: ${wfCount}\n
New observations are matched via embedding cosine similarity — write descriptions in your own words; do not reuse existing wording.`;

  return [catSection, ...wfParts, countSection].filter(Boolean).join("\n");
}

function buildUserAnalysisContext(
  prompts: UserPrompt[],
  existingProfile: UserProfile | null,
  validationPrompt?: string
): string {
  const base = `# User Profile Analysis

Analyze ${prompts.length} user prompts to ${existingProfile ? "update" : "create"} the user profile.
${existingProfile ? `The merge system will automatically connect your observations to existing profile entries — you only need to describe what you see in these recent prompts.` : `Create a new user profile from scratch based on the prompts below.`}

${existingProfile ? buildCategorySummary(JSON.parse(existingProfile.profileData)) : ""}
## Recent Prompts

${prompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n\n")}

## Analysis Guidelines

Identify and ${existingProfile ? "report" : "create"}:

 1. **Preferences**
   - Code style, communication style, tool preferences
   - Assign confidence 0.3-0.5 based on evidence strength in these recent prompts
   - Include 1-3 example prompts as evidence
   - **Revealed preferences**: when the user chooses one approach over alternatives (e.g. picks simpler solution, skips certain steps), capture the choice as a lower-confidence preference (0.3-0.5). What the user does NOT do is also a signal.

 2. **Patterns**
   - Recurring topics, problem domains, technical interests seen in these prompts
   - Track frequency of occurrence

 3. **Workflows**
    - Distinct, named step sequences the user follows repeatedly
    - Each workflow should represent a DIFFERENT activity (different purpose, different steps)
    - Break down into 3-6 concrete, observable steps, NOT abstract phases
    - Do NOT repeat the same workflow every cycle — only output when you observe a NEW recurring sequence
    - Examples of distinct workflows: "debugging workflow", "code review workflow", "learning workflow", "refactoring workflow"

CRITICAL: Only output observations grounded in the RECENT PROMPTS above. Write descriptions in your own words — the system matches by embedding similarity, not exact wording. Do NOT output entries that lack evidence in recent prompts. Put the core semantics at the beginning of each description, keeping descriptions concise and specific (under 120 characters). Do NOT extract one-time debugging tasks, environment setup issues, or specific error investigations as preferences — these are transient events, not behavioral patterns.

## Few-Shot Examples

❌ Do NOT extract as preference:
- "User is debugging a NullPointerException in auth service" (one-time debugging task)
- "User installed Redis for the first time" (one-time setup event)
- "User ran npm audit fix" (routine maintenance, not a behavioral pattern)

✅ DO extract as preference:
- "User prefers functional programming style over OOP"
- "User consistently writes tests before implementation"
- "User asks for explanations before accepting code changes"

✅ DO extract as workflow (distinct, non-overlapping):
- Debugging workflow: "reproduce the error → check logs → grep source code → trace call chain → propose fix → verify fix"
- Code review workflow: "read the diff → check edge cases → verify consistency with existing patterns → report issues → suggest alternatives"
- Learning workflow: "ask for explanation → request examples → test understanding with a small task → apply to real problem"

❌ Do NOT extract as workflow:
- "User analyzes problems and verifies solutions" (too abstract — not a concrete step sequence)
- "User writes code and tests it" (too generic — covers everything)`;

  if (validationPrompt) {
    return base + "\n\n" + validationPrompt;
  }
  return base;
}

type AnalysisResult = { raw: UserProfileData; merged: UserProfileData | null };

function applyValidations(
  profileData: UserProfileData,
  llmResult: UserProfileData,
  profileId: string,
  prefKeys?: string[]
): string | null {
  const validations = (llmResult as any).validations as
    | Array<{
        index: number;
        verdict: string;
        reason: string;
      }>
    | undefined;
  if (!validations?.length || !prefKeys?.length) return null;

  const allItems = [...profileData.preferences, ...profileData.patterns];
  const results: string[] = [];
  let confirmed = 0;
  let contradicted = 0;
  let inaccurate = 0;
  let oversimplified = 0;

  for (const v of validations) {
    const key = prefKeys[v.index];
    if (!key) continue;
    const item = allItems.find(
      (i) => `${i.category || "_"}||${(i.description || "").substring(0, 30)}` === key
    );
    if (!item) {
      log("user-profile-learning: validation match failed", { index: v.index, key });
      continue;
    }

    if (v.verdict === "confirmed") {
      item.alpha = (item.alpha || 1) + 0.5;
      userProfileManager.syncConfidence(item);
      confirmed++;
      results.push(`confirmed [${v.index}] ${v.reason}`);
    } else if (v.verdict === "contradicted") {
      const oldAlpha = item.alpha || 1;
      item.alpha = oldAlpha * 0.75;
      item.beta = (item.beta || 1) + oldAlpha * 0.25;
      userProfileManager.syncConfidence(item);
      contradicted++;
      results.push(`contradicted [${v.index}] ${v.reason}`);
    } else if (v.verdict === "inaccurate") {
      const oldAlpha = item.alpha || 1;
      item.alpha = oldAlpha * 0.6;
      item.beta = (item.beta || 1) + oldAlpha * 0.4;
      userProfileManager.syncConfidence(item);
      inaccurate++;
      results.push(`inaccurate [${v.index}] ${v.reason}`);
    } else if (v.verdict === "oversimplified") {
      const oldAlpha = item.alpha || 1;
      item.alpha = oldAlpha * 0.85;
      item.beta = (item.beta || 1) + oldAlpha * 0.15;
      userProfileManager.syncConfidence(item);
      oversimplified++;
      results.push(`oversimplified [${v.index}] ${v.reason}`);
      const evidence = (item as any).evidence;
      if (Array.isArray(evidence) && evidence.length >= 3) {
        const itemType = profileData.preferences.includes(item) ? "preference" : "pattern";
        userProfileManager.evolveAndUpdate(item, itemType, profileId).catch(() => {});
      }
    } else {
      results.push(`no_evidence [${v.index}] ${v.reason}`);
    }
  }

  if (results.length > 0) {
    log("user-profile-learning: validation results", { validated: results });
  }
  if (confirmed === 0 && contradicted === 0 && inaccurate === 0 && oversimplified === 0)
    return null;

  return `validated: ${confirmed} confirmed, ${contradicted} contradicted, ${inaccurate} inaccurate, ${oversimplified} oversimplified`;
}

async function analyzeUserProfile(
  context: string,
  existingProfile: UserProfile | null
): Promise<AnalysisResult | null> {
  log("user-profile-learning: analyze called", { hasProfile: !!existingProfile });
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    log("user-profile-learning: trying opencode provider");
    try {
      const { generateStructuredOutput } = await loadOpencodeProvider();
      const { getOpenCodeClient } = await import("./ai/profile-llm-client.js");

      log("user-profile-learning: opencode provider diag", {
        provider: CONFIG.opencodeProvider,
        model: CONFIG.opencodeModel,
      });

      const v2Client = await getOpenCodeClient();

      const systemPrompt = `You are a user behavior analyst for a coding assistant.

Your task is to analyze user prompts and ${existingProfile ? "update" : "create"} a comprehensive user profile.

CRITICAL: Detect the language used by the user in their prompts. You MUST output all descriptions, categories, and text in the SAME language as the user's prompts.

CRITICAL: All JSON string values MUST escape double quotes with backslash. Do NOT use unescaped quotation marks inside string values.

Use the update_user_profile tool to save the ${existingProfile ? "updated" : "new"} profile.`;

      const { z } = await import("zod");
      const schema = z.object({
        preferences: z.array(
          z.object({
            category: z.string(),
            description: z.string(),
            confidence: z.number().min(0).max(0.5),
            evidence: z.array(z.string()),
          })
        ),
        patterns: z.array(
          z.object({
            category: z.string(),
            description: z.string(),
          })
        ),
        workflows: z.array(
          z.object({
            description: z.string(),
            steps: z.array(z.string()),
          })
        ),
        validations: z
          .array(
            z.object({
              index: z.number(),
              verdict: z.enum([
                "confirmed",
                "contradicted",
                "no_evidence",
                "inaccurate",
                "oversimplified",
              ]),
              reason: z.string(),
            })
          )
          .optional(),
      });

      log("user-profile-learning: calling LLM", { contextLen: context.length });

      const result = await Promise.race([
        generateStructuredOutput({
          client: v2Client,
          providerID: CONFIG.opencodeProvider,
          modelID: CONFIG.opencodeModel,
          systemPrompt,
          userPrompt: context,
          schema,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("user-profile-learning: timeout")), 120000)
        ),
      ]);

      log("user-profile-learning: LLM returned", {
        prefCount: result.preferences?.length,
        patCount: result.patterns?.length,
        wfCount: result.workflows?.length,
      });

      const rawData = result as unknown as UserProfileData;

      if (existingProfile) {
        const existingData: UserProfileData = JSON.parse(existingProfile.profileData);
        const merged = await userProfileManager.mergeProfileData(
          existingData,
          rawData as unknown as Partial<UserProfileData>,
          undefined,
          existingProfile.id
        );
        return { raw: rawData, merged };
      }
      return { raw: rawData, merged: null };
    } catch (e) {
      log("user-profile-learning: opencode provider failed, falling back to external API", {
        error: String(e),
      });
    }
  }

  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    log("User Profile Config Check Failed:", {
      memoryModel: CONFIG.memoryModel,
      memoryApiUrl: CONFIG.memoryApiUrl,
    });
    throw new Error("External API not configured for user memory learning");
  }

  const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const systemPrompt = `You are a user behavior analyst for a coding assistant.

Your task is to analyze user prompts and ${existingProfile ? "update" : "create"} a comprehensive user profile.

CRITICAL: Detect the language used by the user in their prompts. You MUST output all descriptions, categories, and text in the SAME language as the user's prompts.

CRITICAL: All JSON string values MUST escape double quotes with backslash. Do NOT use unescaped quotation marks inside string values.

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
                confidence: { type: "number", minimum: 0, maximum: 0.5 },
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
          validations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "number" },
                verdict: {
                  type: "string",
                  enum: [
                    "confirmed",
                    "contradicted",
                    "no_evidence",
                    "inaccurate",
                    "oversimplified",
                  ],
                },
                reason: { type: "string" },
              },
              required: ["index", "verdict", "reason"],
            },
          },
        },
        required: ["preferences", "patterns", "workflows"],
      },
    },
  };

  const result = await provider.executeToolCall(
    systemPrompt,
    context,
    toolSchema,
    `user-profile-${Date.now()}`
  );

  if (!result.success || !result.data) {
    throw new Error(result.error || "Failed to analyze user profile");
  }

  const rawData = result.data as UserProfileData;

  if (existingProfile) {
    const existingData: UserProfileData = JSON.parse(existingProfile.profileData);
    const merged = await userProfileManager.mergeProfileData(
      existingData,
      rawData,
      undefined,
      existingProfile.id
    );
    return { raw: rawData, merged };
  }

  return { raw: rawData, merged: null };
}

type LearningPathsResult = { paths: { topic: string; chain: string[]; description: string }[] };

async function buildLearningPaths(prompts: UserPrompt[], profileId: string): Promise<void> {
  const promptTexts = prompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n");
  const systemPrompt =
    "You are a learning path analyst. Identify causal chains across a user's prompts. Output valid JSON.";
  const userPrompt = `Analyze these user prompts for causal learning chains:

${promptTexts}

Identify sequences where earlier prompts led to later ones (e.g. "learned X → applied X → refined X"). Return JSON:
{ "paths": [{ "topic": "string", "chain": ["step1", "step2", "step3"], "description": "one sentence summary" }] }
If no clear chains, return { "paths": [] }.`;

  let result: LearningPathsResult | null = null;

  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    try {
      const { z } = await import("zod");
      const { generateStructuredOutput } = await loadOpencodeProvider();
      const { getOpenCodeClient } = await import("./ai/profile-llm-client.js");

      let v2Client;
      try {
        v2Client = await getOpenCodeClient();
      } catch {
        // provider not available, skip learning paths
      }
      if (v2Client) {
        result = (await Promise.race([
          generateStructuredOutput({
            client: v2Client,
            providerID: CONFIG.opencodeProvider,
            modelID: CONFIG.opencodeModel,
            systemPrompt,
            userPrompt,
            schema: z.object({
              paths: z.array(
                z.object({
                  topic: z.string(),
                  chain: z.array(z.string()),
                  description: z.string(),
                })
              ),
            }),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("learning paths: opencode timeout")), 120000)
          ),
        ])) as LearningPathsResult;
      }
    } catch (e) {
      log("learning paths: native provider failed", { error: String(e) });
    }
  }

  if (!result && CONFIG.memoryModel && CONFIG.memoryApiUrl) {
    try {
      const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`,
        },
        body: JSON.stringify({
          model: CONFIG.memoryModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (content) result = JSON.parse(content) as LearningPathsResult;
      }
    } catch (e) {
      log("learning paths: external API failed", { error: String(e) });
    }
  }

  if (!result?.paths?.length) return;

  log("learning paths: detected", {
    profileId,
    pathCount: result.paths.length,
    topics: result.paths.map((p) => p.topic).join(", "),
  });

  const profile = userProfileManager.getProfileById(profileId);
  if (!profile) return;

  const data: UserProfileData = JSON.parse(profile.profileData);
  data.learning_paths = result.paths;
  userProfileManager.updateProfile(
    profileId,
    data,
    0,
    `Updated learning paths: ${result.paths.map((p) => p.topic).join(", ")}`
  );
}
