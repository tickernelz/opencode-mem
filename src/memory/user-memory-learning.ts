import type { PluginInput } from "@opencode-ai/plugin";
import { getTags } from "./tags.js";
import { log } from "../infra/logger.js";
import { CONFIG } from "../config.js";
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
import type { UserPrompt } from "./user-prompt/user-prompt-manager.js";
import { userProfileManager } from "../user-profile/user-profile-manager.js";
import { sortProfileItems } from "../utils/profile.js";
import type { UserProfile, UserProfileData } from "../user-profile/types.js";
import { loadOpencodeProvider } from "../ai/opencode-provider-loader.js";
import { tryAcquireProfileLearningLock } from "../user-profile/learning-lock.js";

let isLearningRunning = false;

export function shouldRunAutomaticProfileCleanup(
  previousPromptCount: number,
  addedPromptCount: number,
  interval: number = CONFIG.userProfileAutoCleanupInterval
): boolean {
  if (!CONFIG.userProfileAutoCleanupEnabled || !Number.isInteger(interval) || interval <= 0) {
    return false;
  }
  return (
    Math.floor(previousPromptCount / interval) <
    Math.floor((previousPromptCount + addedPromptCount) / interval)
  );
}

async function runAutomaticProfileCleanup(userId: string): Promise<void> {
  try {
    const profile = await userProfileManager.getActiveProfile(userId);
    if (!profile) return;
    const profileData: UserProfileData = JSON.parse(profile.profileData);
    const itemCount =
      profileData.preferences.length + profileData.patterns.length + profileData.workflows.length;
    if (itemCount < 2) return;

    const { aiCleanupProfile } = await import("../user-profile/ai-cleanup.js");
    const result = await aiCleanupProfile(profileData);
    if (result.diff.merged.length === 0 && result.diff.removed.length === 0) return;

    const updated = await userProfileManager.updateProfile(
      profile.id,
      result.cleaned,
      0,
      `Automatic AI cleanup: ${result.diff.merged.length} merged, ${result.diff.removed.length} removed`
    );
    log("user-profile-learning: automatic cleanup complete", {
      userId,
      updated,
      merged: result.diff.merged.length,
      removed: result.diff.removed.length,
    });
  } catch (error) {
    log("user-profile-learning: automatic cleanup failed", { userId, error: String(error) });
  }
}

export async function performUserProfileLearning(
  ctx: PluginInput,
  directory: string
): Promise<void> {
  if (isLearningRunning) return;
  if (!CONFIG.autoCaptureProviderStatus || !CONFIG.autoCaptureProviderStatus.ready) {
    log("user-profile-learning: skipped (provider not ready)", {
      issues: CONFIG.autoCaptureProviderStatus?.issues ?? ["status undefined"],
    });
    return;
  }

  // Set before the first await so a same-process re-entry bounces off the flag
  // instead of queueing behind this run and running a second analysis.
  //
  // `isLearningRunning` only guards re-entry inside one process. Prompt selection
  // is a plain SELECT and the batch is marked only after the LLM responds, so
  // without cross-process exclusion two instances sharing this storage would
  // analyze the same prompts and the slower writer would clobber the faster
  // one's profile update. Contention skips this round; the next idle retries.
  isLearningRunning = true;
  let releaseLearningLock: (() => Promise<void> | void) | null = null;
  try {
    releaseLearningLock = await tryAcquireProfileLearningLock(directory);
    if (!releaseLearningLock) {
      log("user-profile-learning: skipped (another process holds the learning lock)");
      return;
    }

    const count = await userPromptManager.countUnanalyzedForUserLearning();
    const threshold = CONFIG.userProfileAnalysisInterval;

    log("user-profile-learning: check", { count, threshold });

    if (count < threshold) {
      return;
    }

    const prompts = await userPromptManager.getPromptsForUserLearning(threshold);

    if (prompts.length === 0) {
      return;
    }

    const tags = getTags(directory);
    const userId = tags.user.userEmail || "unknown";

    let existingProfile = await userProfileManager.getActiveProfile(userId);
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
    const langName = await resolveProfileLanguageName(prompts);

    const analysisResult = await analyzeUserProfile(context, existingProfile, langName);

    log("user-profile-learning: analyze done", { hasResult: !!analysisResult });

    if (!analysisResult) {
      await userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
      if (prompts.length >= 10 && existingProfile) {
        buildLearningPaths(prompts, existingProfile.id).catch(() => {});
      }
      return;
    }

    const { raw: llmResult, merged: initialMerged } = analysisResult;
    let cleanupPreviousPromptCount = 0;

    if (existingProfile) {
      let updatedProfileData = initialMerged!;
      const MAX_RETRIES = 2;
      let retries = 0;
      let success = false;

      while (!success && retries <= MAX_RETRIES) {
        if (retries > 0) {
          existingProfile = await userProfileManager.getActiveProfile(userId);
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
        cleanupPreviousPromptCount = existingProfile.totalPromptsAnalyzed;

        let changeSummary = generateChangeSummary(
          JSON.parse(existingProfile.profileData),
          updatedProfileData
        );

        const validationSummary = await applyValidations(
          updatedProfileData,
          llmResult,
          existingProfile.id,
          validationPrefKeys
        );
        if (validationSummary) {
          changeSummary = changeSummary + "; " + validationSummary;
        }

        success = await userProfileManager.updateProfile(
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
        // Mark the batch anyway so the same prompts are not retried forever
        // (token burn + repeated toasts on every subsequent idle).
        log("User profile update conflict: exhausted retries", {
          profileId: existingProfile?.id,
          userId,
        });
        await userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
        return;
      }

      await userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
    } else {
      await userProfileManager.createProfile(
        userId,
        tags.user.displayName || "Unknown",
        tags.user.userName || "unknown",
        tags.user.userEmail || "unknown",
        llmResult,
        prompts.length
      );
      await userPromptManager.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
    }

    if (shouldRunAutomaticProfileCleanup(cleanupPreviousPromptCount, prompts.length)) {
      await runAutomaticProfileCleanup(userId);
    }

    if (CONFIG.showUserProfileToasts) {
      await ctx.client?.tui
        .showToast({
          body: {
            title: "User Profile Updated",
            message: `Analyzed ${prompts.length} of ${count} pending prompts and updated your profile`,
            variant: "success",
            duration: 3000,
          },
        })
        .catch(() => {});
    }
  } catch (error) {
    // Guard against corrupt stored profileData (JSON.parse throws) and any other
    // fault: this runs fire-and-forget from the idle timer, so an uncaught rejection
    // would surface as an unhandled promise rejection. The caller (src/hosts/opencode/plugin.ts idle
    // timer) already wraps this call in its own try/catch, and issue #265 requires
    // provider errors to propagate instead of being masked, so rethrow after logging.
    log("user-profile-learning: aborted", { error: String(error) });
    throw error;
  } finally {
    // Release only when the lock was actually acquired (contention return,
    // acquisition failure, and any throw before acquisition all leave it null).
    // The flag resets in a nested finally so it stays raised while the release
    // await is in flight — otherwise a same-process re-entry could slip in and
    // find the cross-process lock already gone — and it still resets when the
    // release itself rejects.
    try {
      await releaseLearningLock?.();
    } finally {
      isLearningRunning = false;
    }
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

  const maxBytes = CONFIG.userProfileMaxContextBytes ?? 32768;
  const truncate = (s: string) =>
    s.length > maxBytes
      ? s.substring(0, maxBytes) + "\n[... context truncated to userProfileMaxContextBytes ...]"
      : s;
  if (validationPrompt) {
    return truncate(base + "\n\n" + validationPrompt);
  }
  return truncate(base);
}

/** Upper bound for LLM-inferred preference confidence (0–1 scale). */
export const USER_PROFILE_LLM_CONFIDENCE_MAX = 1;

/** Shared analysis schema for OpenCode structured output and external tool calls. */
export function createUserProfileAnalysisSchema(z: typeof import("zod").z) {
  return z.object({
    preferences: z.array(
      z.object({
        category: z.string(),
        description: z.string(),
        confidence: z.number().min(0).max(USER_PROFILE_LLM_CONFIDENCE_MAX),
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
}

export function createUserProfileToolSchema(existingProfile: boolean) {
  return {
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
                confidence: {
                  type: "number",
                  minimum: 0,
                  maximum: USER_PROFILE_LLM_CONFIDENCE_MAX,
                },
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
}

type AnalysisResult = { raw: UserProfileData; merged: UserProfileData | null };

async function applyValidations(
  profileData: UserProfileData,
  llmResult: UserProfileData,
  profileId: string,
  prefKeys?: string[]
): Promise<string | null> {
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
        // Await so the in-place description/centroid mutation completes before the
        // caller serializes updatedProfileData — otherwise the evolved description is
        // included or lost nondeterministically. Failures stay non-fatal.
        try {
          await userProfileManager.evolveAndUpdate(item, itemType, profileId);
        } catch {
          // description evolution is best-effort
        }
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

/**
 * Resolves the language the profile-analysis LLM must write in, honoring the
 * same `autoCaptureLanguage` config used by auto-capture (src/memory/auto-capture.ts)
 * so auto-captured memories and the user profile follow the same language setting.
 *
 * In "auto" mode, detection runs on the raw prompt text only — never on the
 * analysis context, whose English instruction scaffold would bias detection
 * toward English for short non-English prompts.
 */
export async function resolveProfileLanguageName(prompts: UserPrompt[]): Promise<string> {
  const { detectLanguage, getLanguageName } = await import("../infra/language-detector.js");
  const targetLang =
    CONFIG.autoCaptureLanguage === "auto" || !CONFIG.autoCaptureLanguage
      ? detectLanguage(prompts.map((p) => p.content).join("\n\n"))
      : CONFIG.autoCaptureLanguage;
  return getLanguageName(targetLang);
}

function buildProfileSystemPrompt(existingProfile: UserProfile | null, langName: string): string {
  return `You are a user behavior analyst for a coding assistant.

Your task is to analyze user prompts and ${existingProfile ? "update" : "create"} a comprehensive user profile.

CRITICAL: You MUST write all descriptions, categories, and text in ${langName}.

CRITICAL: All JSON string values MUST escape double quotes with backslash. Do NOT use unescaped quotation marks inside string values.

Use the update_user_profile tool to save the ${existingProfile ? "updated" : "new"} profile.`;
}

async function analyzeUserProfile(
  context: string,
  existingProfile: UserProfile | null,
  langName: string
): Promise<AnalysisResult | null> {
  const systemPrompt = buildProfileSystemPrompt(existingProfile, langName);
  log("user-profile-learning: analyze called", { hasProfile: !!existingProfile });
  let opencodeProviderError: unknown;
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    log("user-profile-learning: trying opencode provider");
    // The try/catch boundary is the provider only: LLM client construction,
    // the structured-output call, and schema binding. Stored-profile parsing
    // and merging happen AFTER a successful LLM response and outside this
    // try — a cold-storage read/parse/merge failure must propagate to the
    // caller (logged + rethrown there), never be mistaken for a provider
    // fault that silently falls back to the external API and then
    // re-reads/re-merges the same broken storage.
    let rawData: UserProfileData | null = null;
    try {
      const { generateStructuredOutput } = await loadOpencodeProvider();
      const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

      log("user-profile-learning: opencode provider diag", {
        provider: CONFIG.opencodeProvider,
        model: CONFIG.opencodeModel,
      });

      const v2Client = await getOpenCodeClient();

      const { z } = await import("zod");
      const schema = createUserProfileAnalysisSchema(z);

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

      rawData = result as unknown as UserProfileData;
    } catch (e) {
      opencodeProviderError = e;
      log("user-profile-learning: opencode provider failed, falling back to external API", {
        error: String(e),
      });
    }

    // Stored-profile parse/merge runs only after a native success and is
    // deliberately OUTSIDE the provider catch: storage faults here are not
    // provider faults and must not trigger the external fallback.
    if (rawData !== null) {
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
    }
  }

  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    if (opencodeProviderError) {
      throw opencodeProviderError;
    }
    log("User Profile Config Check Failed:", {
      memoryModel: CONFIG.memoryModel,
      memoryApiUrl: CONFIG.memoryApiUrl,
    });
    throw new Error("External API not configured for user memory learning");
  }

  const { AIProviderFactory } = await import("../ai/ai-provider-factory.js");
  const { buildMemoryProviderConfig } = await import("../ai/provider-config.js");

  const providerConfig = buildMemoryProviderConfig(CONFIG);

  const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);

  const toolSchema = createUserProfileToolSchema(Boolean(existingProfile));

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
      const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

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

  const profile = await userProfileManager.getProfileById(profileId);
  if (!profile) return;

  const data: UserProfileData = JSON.parse(profile.profileData);
  data.learning_paths = result.paths;
  await userProfileManager.updateProfile(
    profileId,
    data,
    0,
    `Updated learning paths: ${result.paths.map((p) => p.topic).join(", ")}`
  );
}
