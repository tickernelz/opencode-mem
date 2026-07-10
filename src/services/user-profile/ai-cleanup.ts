import type { UserProfileData } from "./types.js";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import { loadOpencodeProvider } from "../ai/opencode-provider-loader.js";

export interface AICleanupResult {
  cleaned: UserProfileData;
  diff: CleanupDiff;
}

export interface CleanupDiff {
  kept: string[];
  merged: Array<{ ids: string[]; result: string }>;
  removed: Array<{ id: string; reason: string }>;
}

export async function aiCleanupProfile(profileData: UserProfileData): Promise<AICleanupResult> {
  const t0 = Date.now();
  const indexed = addIdsToProfile(profileData);
  const prompt = buildAICleanupPrompt(indexed);

  log("AI cleanup: prompt built", {
    prefCount: indexed.preferences.length,
    patCount: indexed.patterns.length,
    wfCount: indexed.workflows.length,
    promptLen: prompt.length,
    buildMs: Date.now() - t0,
  });

  const aiStart = Date.now();
  const result = await callAICleanup(prompt);
  log("AI cleanup: AI response received", { callMs: Date.now() - aiStart });

  const cleanedById = buildItemIndex(result.profile);
  const originalById = buildItemIndex(indexed);
  const counters = { cleaned: 0, original: 0 };

  const cleaned = rebuildProfileUsing(result.mapping, cleanedById, originalById, counters);
  const diff = generateDiff(indexed, result.mapping);

  const sampleCleaned = result.profile.preferences[0];
  log("AI cleanup: rebuild done", {
    cleanedPrefCount: result.profile.preferences.length,
    cleanedPatCount: result.profile.patterns.length,
    cleanedWfCount: result.profile.workflows.length,
    sampleId: sampleCleaned?.id,
    sampleDescLen: sampleCleaned?.description?.length,
    cleanedItemDescLen: cleanedById.get("pref_0")?.description?.length,
    originalItemDescLen: originalById.get("pref_0")?.description?.length,
    keptById: cleaned.preferences.length,
    usedCleaned: counters.cleaned,
    usedOriginal: counters.original,
  });

  log("AI cleanup: complete", {
    totalMs: Date.now() - t0,
    kept: diff.kept.length,
    merged: diff.merged.length,
    removed: diff.removed.length,
  });

  return { cleaned, diff };
}

export async function aiCleanupProfileFromIndexed(
  indexed: IndexedProfile
): Promise<AICleanupResult> {
  const t0 = Date.now();
  const prompt = buildAICleanupPrompt(indexed);

  log("AI cleanup: prompt built (filtered)", {
    prefCount: indexed.preferences.length,
    patCount: indexed.patterns.length,
    wfCount: indexed.workflows.length,
    promptLen: prompt.length,
    buildMs: Date.now() - t0,
  });

  const aiStart = Date.now();
  const result = await callAICleanup(prompt);
  log("AI cleanup: AI response received (filtered)", { callMs: Date.now() - aiStart });

  const cleanedById = buildItemIndex(result.profile);
  const originalById = buildItemIndex(indexed);
  const counters = { cleaned: 0, original: 0 };

  const cleaned = rebuildProfileUsing(result.mapping, cleanedById, originalById, counters);
  const diff = generateDiff(indexed, result.mapping);

  log("AI cleanup: complete (filtered)", {
    totalMs: Date.now() - t0,
    kept: diff.kept.length,
    merged: diff.merged.length,
    removed: diff.removed.length,
  });

  return { cleaned, diff };
}

export function filterProfileForCleanup(
  profileData: UserProfileData,
  includeIds: string[]
): IndexedProfile {
  const idSet = new Set(includeIds);
  const indexed = addIdsToProfile(profileData);
  return {
    preferences: indexed.preferences.filter((p) => idSet.has(p.id)),
    patterns: indexed.patterns.filter((p) => idSet.has(p.id)),
    workflows: indexed.workflows.filter((p) => idSet.has(p.id)),
  };
}

interface IndexedProfileItem {
  id: string;
  category?: string;
  description: string;
  confidence?: number;
  frequency?: number;
  [key: string]: unknown;
}

interface IndexedProfile {
  preferences: IndexedProfileItem[];
  patterns: IndexedProfileItem[];
  workflows: IndexedProfileItem[];
}

interface AIMapping {
  kept: string[];
  merged: string[][];
  removed: string[];
}

function addIdsToProfile(profile: UserProfileData): IndexedProfile {
  const items = {
    preferences: profile.preferences.map((p, i) => ({ ...p, id: `pref_${i}` })),
    patterns: profile.patterns.map((p, i) => ({ ...p, id: `pat_${i}` })),
    workflows: profile.workflows.map((w, i) => ({ ...w, id: `wf_${i}` })),
  };
  return items;
}

function buildAICleanupPrompt(profile: IndexedProfile): string {
  const profileJSON = JSON.stringify(
    {
      preferences: profile.preferences.map(formatForAI),
      patterns: profile.patterns.map(formatForAI),
      workflows: profile.workflows.map(formatForAI),
    },
    null,
    2
  );

  return `You are a user profile analyst. The profile below contains duplicate entries within each category (preferences, patterns, workflows). Output a cleaned profile.

Rules:
1. Merge semantically identical entries ONLY within the same section (pref_ with pref_, pat_ with pat_, wf_ with wf_)
2. Do NOT merge across sections — preferences and patterns are different things
3. When merging, keep the most specific description. Do not artificially shorten or inflate — the natural length of the original is fine.
4. Do not add new entries; only merge and remove
5. Prefer merging over removing. If entries share the same topic or describe similar behavior, merge them. Only remove truly irrelevant/generic items that add no value (e.g. "uses tools", "checks things").
6. You MUST return a mapping showing the disposition of each id

Current profile:
${profileJSON}

Return JSON only (no markdown):
{
  "preferences": [
    { "id": "pref_0", "category": "...", "description": "..." }
  ],
  "patterns": [...],
  "workflows": [...],
  "mapping": {
    "kept": ["pref_0", "pat_1"],
    "merged": [["pref_2", "pref_5"], ["pat_3", "pat_8"]],
    "removed": ["pref_4"]
  }
}

The first id in each merged group is the kept entry; the rest are merged into it.`;
}

function formatForAI(item: IndexedProfileItem): Record<string, unknown> {
  const { id, category, description, frequency } = item;
  return { id, category, description, frequency };
}

async function callAICleanup(
  prompt: string
): Promise<{ profile: IndexedProfile; mapping: AIMapping }> {
  // Use opencode internal session when opencodeProvider is configured (same pattern as auto-capture)
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    try {
      const { getV2Client } = await loadOpencodeProvider();
      const v2Client = getV2Client();
      if (v2Client) {
        const result = await callViaOpencodeWithClient(v2Client, prompt);
        if (result) return result;
      }
    } catch (e) {
      log("AI cleanup: opencode session failed, falling back to external API", {
        error: String(e),
      });
    }
  }

  if (CONFIG.memoryModel && CONFIG.memoryApiUrl) {
    return callViaExternalAPI(prompt);
  }

  throw new Error("No AI provider configured for profile cleanup");
}

async function callViaExternalAPI(
  prompt: string
): Promise<{ profile: IndexedProfile; mapping: AIMapping }> {
  const t0 = Date.now();
  const systemPrompt =
    "You are a user profile cleanup assistant. Merge duplicate entries and return only JSON.";

  const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.memoryApiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.memoryModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(60000),
  });

  log("AI cleanup: external API http done", { httpMs: Date.now() - t0, status: response.status });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content in API response");

  log("AI cleanup: external API parsing done", {
    totalMs: Date.now() - t0,
    respLen: content.length,
  });

  const parsed = JSON.parse(content);
  return {
    profile: parsed as IndexedProfile,
    mapping: parsed.mapping as AIMapping,
  };
}

async function callViaOpencodeWithClient(
  v2Client: any,
  prompt: string
): Promise<{ profile: IndexedProfile; mapping: AIMapping }> {
  const t0 = Date.now();
  const systemPrompt =
    "You are a user profile cleanup assistant. Merge duplicate entries and return only JSON without markdown wrapping.";

  const created = (await Promise.race([
    v2Client.session.create({
      title: "opencode-mem profile cleanup",
      directory: process.cwd(),
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("session.create timeout")), 30000)
    ),
  ])) as any;
  log("AI cleanup: session.create result", {
    rawType: typeof created,
    keys: Object.keys(created || {}),
    hasData: !!created?.data,
    dataId: created?.data?.id,
  });

  const sessionID = created?.data?.id || created?.id || created?.sessionID;
  if (!sessionID) throw new Error("session.create returned no session id");

  log("AI cleanup: session created", { sessionID, createMs: Date.now() - t0 });

  try {
    const TIMEOUT_MS = 120000;
    const promptResult = await Promise.race([
      v2Client.session.prompt({
        sessionID,
        model: {
          providerID: CONFIG.opencodeProvider || "bs-aigw",
          modelID: CONFIG.opencodeModel || "deepseek-v4-flash",
        },
        system: systemPrompt,
        parts: [{ type: "text", text: prompt }],
        noReply: true,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`opencodeClient prompt timeout after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS
        )
      ),
    ]);

    log("AI cleanup: session.prompt done", { promptMs: Date.now() - t0 });

    const info = (
      promptResult as {
        data?: { info?: { text?: string; error?: { name: string; data?: { message?: string } } } };
      }
    ).data?.info;

    if (!info) throw new Error("prompt response missing info");
    if (info.error)
      throw new Error(`opencode reported ${info.error.name}: ${info.error.data?.message ?? ""}`);

    const rawText = info.text?.trim() || "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI response did not contain valid JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      profile: parsed as IndexedProfile,
      mapping: parsed.mapping as AIMapping,
    };
  } finally {
    try {
      await v2Client.session.delete({ sessionID });
    } catch {}
  }
}

function buildItemIndex(profile: IndexedProfile): Map<string, IndexedProfileItem> {
  const map = new Map<string, IndexedProfileItem>();
  for (const item of profile.preferences) map.set(item.id, item);
  for (const item of profile.patterns) map.set(item.id, item);
  for (const item of profile.workflows) map.set(item.id, item);
  return map;
}

function rebuildProfileUsing(
  mapping: AIMapping,
  cleanedById: Map<string, IndexedProfileItem>,
  originalById: Map<string, IndexedProfileItem>,
  counters?: { cleaned: number; original: number }
): UserProfileData {
  const keptIds = new Set<string>(
    [...mapping.kept, ...mapping.merged.map((g) => g[0] ?? "")].filter(Boolean)
  );

  const mergedGroups = mapping.merged.filter((g) => g.length > 1);
  const mergedSourceIds = new Set<string>();
  for (const group of mergedGroups) {
    for (let i = 1; i < group.length; i++) {
      mergedSourceIds.add(group[i] ?? "");
    }
  }

  const result: UserProfileData = { preferences: [], patterns: [], workflows: [] };

  for (const id of keptIds) {
    const cleanedItem = cleanedById.get(id);
    const originalItem = originalById.get(id);
    const item = cleanedItem || originalItem;
    if (!item) continue;

    if (counters) {
      if (cleanedById.has(id)) counters.cleaned++;
      else counters.original++;
    }

    const resultItem = { ...item };
    delete (resultItem as any).id;

    if (originalItem) {
      const preserveKeys = [
        "centroid",
        "anchor",
        "weakHitCount",
        "lastWeakHitAt",
        "driftBelowCount",
        "frequency",
        "evidence",
        "steps",
        "confidence",
        "alpha",
        "beta",
        "weakAlpha",
        "weakBeta",
        "lastMatchTime",
        "firstSeen",
        "pendingValidation",
      ];
      for (const key of preserveKeys) {
        if ((originalItem as any)[key] !== undefined && (resultItem as any)[key] === undefined) {
          (resultItem as any)[key] = (originalItem as any)[key];
        }
      }

      if (cleanedItem && cleanedItem.description !== originalItem.description) {
        (resultItem as any).centroid = undefined;
        (resultItem as any).anchor = undefined;
      }
    }

    if (mergedGroups.some((g) => g[0] === id)) {
      const group = mergedGroups.find((g) => g[0] === id)!;
      let bestFreq = (originalItem as any).frequency || 0;
      let bestCentroid = (originalItem as any).centroid;
      let bestAnchor = (originalItem as any).anchor;
      for (let i = 1; i < group.length; i++) {
        const srcOriginal = originalById.get(group[i] ?? "");
        if (srcOriginal) {
          const srcFreq = (srcOriginal as any).frequency || 0;
          if (srcFreq > bestFreq) {
            bestFreq = srcFreq;
            bestCentroid = (srcOriginal as any).centroid;
            bestAnchor = (srcOriginal as any).anchor;
          }
          if ((srcOriginal as any).evidence) {
            const existingEvidence = (resultItem as any).evidence || [];
            const merged = [
              ...new Set([...(srcOriginal as any).evidence, ...existingEvidence]),
            ].slice(0, 10);
            (resultItem as any).evidence = merged;
          }
        }
      }
      // Take sum frequency — accumulating confirmed merges
      let totalFreq = (originalItem as any).frequency || 0;
      for (let i = 1; i < group.length; i++) {
        const srcOriginal = originalById.get(group[i] ?? "");
        if (srcOriginal) {
          totalFreq += (srcOriginal as any).frequency || 0;
        }
      }
      (resultItem as any).frequency = totalFreq;
      // Accumulate alpha/beta from merged items
      const keeperAlpha = (originalItem as any).alpha || 1;
      const keeperBeta = (originalItem as any).beta || 1;
      let mergedAlpha = keeperAlpha;
      let mergedBeta = keeperBeta;
      for (let i = 1; i < group.length; i++) {
        const srcOriginal = originalById.get(group[i] ?? "");
        if (srcOriginal) {
          mergedAlpha += (srcOriginal as any).alpha || 1;
          mergedBeta += (srcOriginal as any).beta || 1;
        }
      }
      (resultItem as any).alpha = mergedAlpha;
      (resultItem as any).beta = mergedBeta;
      (resultItem as any).lastMatchTime = Math.max(
        (originalItem as any).lastMatchTime || 0,
        ...group.slice(1).map((id) => (originalById.get(id ?? "") as any)?.lastMatchTime || 0)
      );
      (resultItem as any).lastSeen = Math.max(
        (originalItem as any).lastSeen || 0,
        ...group.slice(1).map((id) => (originalById.get(id ?? "") as any)?.lastSeen || 0)
      );
      (resultItem as any).pendingValidation =
        !!(originalItem as any).pendingValidation &&
        group.slice(1).every((id) => !!(originalById.get(id ?? "") as any)?.pendingValidation);
      let mergedWeakAlpha = (originalItem as any).weakAlpha || 1;
      let mergedWeakBeta = (originalItem as any).weakBeta || 1;
      for (let i = 1; i < group.length; i++) {
        const srcOriginal = originalById.get(group[i] ?? "");
        if (srcOriginal) {
          mergedWeakAlpha += ((srcOriginal as any).weakAlpha || 1) - 1;
          mergedWeakBeta += ((srcOriginal as any).weakBeta || 1) - 1;
        }
      }
      (resultItem as any).weakAlpha = mergedWeakAlpha;
      (resultItem as any).weakBeta = mergedWeakBeta;
      if (bestCentroid) (resultItem as any).centroid = bestCentroid;
      if (bestAnchor) (resultItem as any).anchor = bestAnchor;
    }

    if (id.startsWith("pref_")) result.preferences.push(resultItem as any);
    else if (id.startsWith("pat_")) result.patterns.push(resultItem as any);
    else if (id.startsWith("wf_")) result.workflows.push(resultItem as any);
  }

  const allOriginalIds = new Set<string>();
  for (const item of originalById.values()) {
    if (item.id) allOriginalIds.add(item.id);
  }
  const unmentionedIds = new Set<string>();
  for (const id of allOriginalIds) {
    if (!keptIds.has(id) && !mapping.removed.includes(id)) {
      unmentionedIds.add(id);
    }
  }

  for (const id of unmentionedIds) {
    const originalItem = originalById.get(id);
    if (!originalItem) continue;
    const resultItem = { ...originalItem };
    delete (resultItem as any).id;
    if (id.startsWith("pref_")) {
      result.preferences.push(resultItem as any);
    } else if (id.startsWith("pat_")) {
      result.patterns.push(resultItem as any);
    } else if (id.startsWith("wf_")) {
      result.workflows.push(resultItem as any);
    } else if (originalItem.category) {
      result.preferences.push(resultItem as any);
    } else {
      result.preferences.push(resultItem as any);
    }
  }

  return result;
}

function generateDiff(original: IndexedProfile, mapping: AIMapping): CleanupDiff {
  const index = buildItemIndex(original);

  const diff: CleanupDiff = {
    kept: mapping.kept.map((id) => index.get(id)?.description || id),
    merged: mapping.merged.map((group) => {
      const first = group[0] ?? "";
      return {
        ids: group,
        result: index.get(first)?.description || first,
      };
    }),
    removed: mapping.removed.map((id) => ({
      id,
      reason: index.get(id)
        ? "AI determined this is a duplicate or stale entry"
        : "Entry no longer exists",
    })),
  };

  return diff;
}
