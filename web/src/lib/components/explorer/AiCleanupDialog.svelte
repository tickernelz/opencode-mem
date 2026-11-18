<script lang="ts">
  import { untrack } from "svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import GitMerge from "@lucide/svelte/icons/git-merge";
  import Loader from "@lucide/svelte/icons/loader";
  import Target from "@lucide/svelte/icons/target";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { toast } from "$lib/toast/toast.svelte";
  import { fetchAPI, toastApiResult } from "$lib/api";
  import AppDialog from "$lib/components/ui/app-dialog.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import DialogActions from "$lib/components/ui/dialog-actions.svelte";
  import SelectableRow from "$lib/components/ui/selectable-row.svelte";
  import WorkflowSteps from "$lib/components/ui/workflow-steps.svelte";
  import { truncate } from "$lib/format";
  import { useI18n } from "$lib/i18n/context.svelte";
  import {
    confidencePct,
    findDescById,
    findStepsById,
    flattenProfileItems,
    normalizeProfileData,
    profileTypeLabel,
    type CleanupItem,
  } from "$lib/profile-utils";
  import { toggleInSet } from "$lib/set-utils";
  import type { PendingCleanup, UserProfile } from "$lib/types";
  import {
    CARD_PAD,
    GAP,
    GAP_LOOSE,
    GAP_TIGHT,
    GAP_WIDE,
    ICON,
    ICON_SM,
    ICON_XS,
    STACK_DENSE,
    STACK_DENSE_MD,
    STACK_FORM,
    STACK_TIGHT,
    SURFACE_CARD,
  } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    open?: boolean;
    profile?: UserProfile | null;
    onOpenChange?: (open: boolean) => void;
    onApplied?: () => void;
  };

  let { open = $bindable(false), profile = null, onOpenChange, onApplied }: Props = $props();

  const i18n = useI18n();
  let phase = $state<"select" | "loading" | "diff">("select");
  let allItems = $state<CleanupItem[]>([]);
  let selectedIds = $state(new Set<string>());
  let pendingCleanup = $state<PendingCleanup | null>(null);
  let acceptedMerged = $state(new Set<number>());
  let acceptedRemoved = $state(new Set<number>());
  let keptOpen = $state(false);
  let applying = $state(false);
  let wasOpen = false;

  const cats = $derived.by(() => {
    const map: Record<string, { pref: CleanupItem[]; pat: CleanupItem[]; wf: CleanupItem[] }> = {};
    for (const it of allItems) {
      const cat = it.category || "(none)";
      if (!map[cat]) map[cat] = { pref: [], pat: [], wf: [] };
      map[cat][it._type].push(it);
    }
    return map;
  });

  const sortedCatKeys = $derived(Object.keys(cats).sort());
  const selectedCount = $derived(selectedIds.size);
  const diffSelectedCount = $derived(acceptedMerged.size + acceptedRemoved.size);
  const diffTotalCount = $derived(
    (pendingCleanup?.changes.merged?.length || 0) + (pendingCleanup?.changes.removed?.length || 0)
  );

  const typeLabels = $derived({
    pref: i18n.t("profile-type-pref"),
    pat: i18n.t("profile-type-pat"),
    wf: i18n.t("profile-type-wf"),
  });

  function initSelect() {
    const pd = normalizeProfileData(profile?.profileData);
    if (!pd) {
      toast.error("No profile data loaded");
      handleOpenChange(false);
      return;
    }

    const items = flattenProfileItems(pd);
    allItems = items;
    selectedIds = new Set(items.filter((it) => (it.frequency || 0) <= 3).map((it) => it._id));
    phase = "select";
    pendingCleanup = null;
    keptOpen = false;
  }

  $effect(() => {
    const isOpen = open;
    if (isOpen && !wasOpen) {
      untrack(() => initSelect());
    } else if (!isOpen && wasOpen) {
      phase = "select";
      pendingCleanup = null;
      applying = false;
    }
    wasOpen = isOpen;
  });

  function handleOpenChange(next: boolean) {
    open = next;
    onOpenChange?.(next);
  }

  function toggleId(id: string, checked: boolean) {
    selectedIds = toggleInSet(selectedIds, id, checked);
  }

  function selectAll() {
    selectedIds = new Set(allItems.map((it) => it._id));
  }

  function selectNone() {
    selectedIds = new Set();
  }

  function selectLow() {
    selectedIds = new Set(allItems.filter((it) => (it.frequency || 0) <= 3).map((it) => it._id));
  }

  function selectSameCat() {
    const next = new Set<string>();
    for (const cat of Object.keys(cats)) {
      const items = [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf];
      if (items.length >= 3) {
        for (const it of items) next.add(it._id);
      }
    }
    selectedIds = next;
  }

  async function analyze() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      toast.warning("No items selected");
      return;
    }
    phase = "loading";
    const result = await fetchAPI<PendingCleanup>("/api/user-profile/ai-cleanup", {
      method: "POST",
      body: JSON.stringify({ includeIds: ids, profileVersion: profile?.version }),
      // Covers max userProfileCleanupTimeoutMs (600s) + HTTP idle grace (30s).
      timeout: 630000,
    });
    if (
      !(await toastApiResult(result, { failKey: "toast-ai-cleanup-failed", translate: i18n.t })) ||
      !result.data
    ) {
      phase = "select";
      return;
    }
    pendingCleanup = result.data;
    acceptedMerged = new Set((result.data.changes.merged || []).map((_, i) => i));
    acceptedRemoved = new Set((result.data.changes.removed || []).map((_, i) => i));
    phase = "diff";
  }

  function toggleMerged(i: number, checked: boolean) {
    acceptedMerged = toggleInSet(acceptedMerged, i, checked);
  }

  function toggleRemoved(i: number, checked: boolean) {
    acceptedRemoved = toggleInSet(acceptedRemoved, i, checked);
  }

  function selectAllDiff() {
    acceptedMerged = new Set((pendingCleanup?.changes.merged || []).map((_, i) => i));
    acceptedRemoved = new Set((pendingCleanup?.changes.removed || []).map((_, i) => i));
  }

  function deselectAllDiff() {
    acceptedMerged = new Set();
    acceptedRemoved = new Set();
  }

  async function apply() {
    if (!pendingCleanup || diffSelectedCount === 0) return;
    applying = true;
    const acceptedMergedIds = [...acceptedMerged]
      .map((mi) => pendingCleanup?.changes.merged?.[mi]?.ids)
      .filter((ids): ids is string[] => !!ids);
    const acceptedRemovedIds = [...acceptedRemoved]
      .map((ri) => pendingCleanup?.changes.removed?.[ri]?.id)
      .filter((id): id is string => !!id);

    const result = await fetchAPI("/api/user-profile/ai-cleanup/apply", {
      method: "POST",
      body: JSON.stringify({
        profile: pendingCleanup.new,
        acceptedMerged: acceptedMergedIds,
        acceptedRemoved: acceptedRemovedIds,
      }),
    });
    applying = false;

    await toastApiResult(result, {
      successKey: "toast-ai-cleanup-success",
      failKey: "toast-cleanup-apply-failed",
      translate: i18n.t,
      onSuccess: () => {
        handleOpenChange(false);
        onApplied?.();
      },
    });
  }
</script>

<AppDialog
  bind:open
  title={i18n.t("label-ai-cleanup-title")}
  class="sm:max-w-2xl {GAP_WIDE}"
  onOpenChange={handleOpenChange}
>
  {#if phase === "loading"}
    <div class="flex flex-col items-center {GAP_LOOSE} py-10 text-muted-foreground">
      <Loader class={cn(ICON, "size-6 animate-spin")} aria-hidden="true" />
      <span class="text-sm">{i18n.t("label-ai-cleanup-loading")}</span>
    </div>
  {:else if phase === "select"}
    <div class="flex min-h-0 flex-1 flex-col {GAP_LOOSE} overflow-hidden">
      <div class="flex flex-wrap items-center justify-between {GAP}">
        <h3 class="text-sm font-medium">{i18n.t("label-ai-cleanup-select")}</h3>
        <div class="flex flex-wrap {GAP_TIGHT}">
          <Button variant="secondary" size="xs" onclick={selectAll}>
            {i18n.t("label-ai-cleanup-select-all")}
          </Button>
          <Button variant="secondary" size="xs" onclick={selectNone}>
            {i18n.t("label-ai-cleanup-deselect-all")}
          </Button>
          <Button variant="secondary" size="xs" onclick={selectLow}>
            {i18n.t("label-ai-cleanup-select-low")}
          </Button>
          <Button variant="secondary" size="xs" onclick={selectSameCat}>
            {i18n.t("label-ai-cleanup-select-same-cat")}
          </Button>
        </div>
      </div>
      <div class={cn("min-h-0 flex-1 overflow-y-auto pr-1", STACK_FORM)}>
        {#each sortedCatKeys as cat (cat)}
          {@const items = [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf]}
          <div class={STACK_DENSE_MD}>
            <div class="flex items-center {GAP}">
              <span class="text-xs rounded-full bg-muted px-2 py-0.5">{cat}</span>
              <span class="text-xs text-muted-foreground">{items.length} items</span>
            </div>
            {#each items as it (it._id)}
              {@const checked = selectedIds.has(it._id)}
              <SelectableRow
                {checked}
                class="rounded-xl border border-border/60 px-2 py-1.5 hover:bg-muted/40"
                onToggle={(next) => toggleId(it._id, next)}
              >
                <span class="text-[10px] font-medium text-muted-foreground w-4">
                  {it._type === "pref" ? "P" : it._type === "pat" ? "T" : "W"}
                </span>
                <span class="flex-1 truncate">
                  {truncate(it.description || "", 80)}
                </span>
                <span class="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                  <Target class={ICON_XS} aria-hidden="true" />
                  {it.frequency || 0}{it.confidence != null ? ` | ${confidencePct(it)}%` : ""}
                </span>
              </SelectableRow>
            {/each}
          </div>
        {/each}
      </div>
      <div class="flex items-center justify-between {GAP} pt-1">
        <span class="text-xs text-muted-foreground">
          {i18n.t("label-ai-cleanup-selected", { count: selectedCount })}
        </span>
        <Button onclick={analyze}>{i18n.t("label-ai-cleanup-analyze")}</Button>
      </div>
    </div>
  {:else if phase === "diff" && pendingCleanup}
    <div class="flex min-h-0 flex-1 flex-col {GAP_LOOSE} overflow-hidden">
      <div class="flex flex-wrap items-center justify-between {GAP}">
        <span class="text-xs text-muted-foreground">
          {i18n.t("label-ai-cleanup-changes-selected", {
            selected: diffSelectedCount,
            total: diffTotalCount,
          })}
        </span>
        <div class="flex {GAP}">
          <Button variant="link" size="xs" onclick={selectAllDiff}>
            {i18n.t("label-ai-cleanup-select-all")}
          </Button>
          <Button variant="link" size="xs" onclick={deselectAllDiff}>
            {i18n.t("label-ai-cleanup-deselect-all")}
          </Button>
        </div>
      </div>
      <div class={cn("min-h-0 flex-1 overflow-y-auto pr-1", STACK_FORM)}>
        {#if (pendingCleanup.changes.merged || []).length > 0}
          <div class={STACK_TIGHT}>
            <h4 class="flex items-center {GAP_TIGHT} text-sm font-medium">
              <GitMerge class={ICON_SM} aria-hidden="true" />
              {i18n.t("label-ai-cleanup-merged-header", {
                count: pendingCleanup.changes.merged?.length || 0,
              })}
            </h4>
            {#each pendingCleanup.changes.merged || [] as m, mi (mi)}
              {@const mergedFrom = m.ids.slice(1)}
              {@const mainDesc = m.result || ""}
              {@const mainSteps = findStepsById(m.ids[0], pendingCleanup.old)}
              {@const mergeChecked = acceptedMerged.has(mi)}
              <div class={cn(SURFACE_CARD, CARD_PAD, STACK_TIGHT)}>
                <SelectableRow checked={mergeChecked} onToggle={(next) => toggleMerged(mi, next)}>
                  <span>{i18n.t("label-ai-cleanup-merge-check")}</span>
                </SelectableRow>
                <div class="grid {GAP} sm:grid-cols-[1fr_auto_1fr] items-start text-sm">
                  <div class={STACK_DENSE_MD}>
                    {#each mergedFrom as id (id)}
                      {@const desc = findDescById(id, pendingCleanup.old)}
                      {@const steps = findStepsById(id, pendingCleanup.old)}
                      {#if desc}
                        <div class="rounded-lg bg-muted/50 p-2 {STACK_DENSE}">
                          <div>
                            <span class="text-[10px] rounded bg-muted px-1.5 py-0.5">
                              {profileTypeLabel(id, typeLabels)}
                            </span>
                            {" "}
                            {truncate(desc, 80)}
                          </div>
                          {#if steps?.length}
                            <WorkflowSteps {steps} variant="inline" />
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                  <div class="text-muted-foreground self-center grid place-items-center">
                    <ChevronRight class={ICON} aria-hidden="true" />
                  </div>
                  <div class="rounded-lg bg-primary/10 p-2 {STACK_DENSE}">
                    <div>{truncate(mainDesc, 120)}</div>
                    {#if mainSteps?.length}
                      <WorkflowSteps steps={mainSteps} variant="inline" />
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if (pendingCleanup.changes.removed || []).length > 0}
          <div class={STACK_TIGHT}>
            <h4 class="flex items-center {GAP_TIGHT} text-sm font-medium">
              <Trash2 class={ICON_SM} aria-hidden="true" />
              {i18n.t("label-ai-cleanup-removed-header", {
                count: pendingCleanup.changes.removed?.length || 0,
              })}
            </h4>
            {#each pendingCleanup.changes.removed || [] as r, ri (ri)}
              {@const desc = findDescById(r.id, pendingCleanup.old)}
              {@const steps = findStepsById(r.id, pendingCleanup.old)}
              {@const removeChecked = acceptedRemoved.has(ri)}
              <div class={cn(SURFACE_CARD, CARD_PAD, STACK_TIGHT)}>
                <SelectableRow checked={removeChecked} onToggle={(next) => toggleRemoved(ri, next)}>
                  <span>{i18n.t("label-ai-cleanup-remove-check")}</span>
                </SelectableRow>
                <div class="text-sm">{desc || r.id}</div>
                {#if steps?.length}
                  <WorkflowSteps {steps} variant="inline" />
                {/if}
                <div class="text-xs text-muted-foreground">{r.reason}</div>
              </div>
            {/each}
          </div>
        {/if}

        {#if (pendingCleanup.changes.kept || []).length > 0}
          <div class={STACK_TIGHT}>
            <button
              type="button"
              class="flex items-center {GAP_TIGHT} text-sm font-medium"
              onclick={() => (keptOpen = !keptOpen)}
            >
              {i18n.t("label-ai-cleanup-kept")}
              <span class="text-muted-foreground">
                ({pendingCleanup.changes.kept?.length || 0})
              </span>
              {#if keptOpen}
                <ChevronUp class={ICON_SM} aria-hidden="true" />
              {:else}
                <ChevronDown class={ICON_SM} aria-hidden="true" />
              {/if}
            </button>
            {#if keptOpen}
              <div class={STACK_DENSE}>
                {#each pendingCleanup.changes.kept || [] as k, ki (ki)}
                  <div class="text-xs text-muted-foreground rounded bg-muted/40 px-2 py-1">
                    {k}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <DialogActions
      onCancel={() => handleOpenChange(false)}
      primaryLabel={phase === "diff"
        ? diffSelectedCount > 0
          ? `${i18n.t("label-ai-cleanup-apply")} (${diffSelectedCount})`
          : i18n.t("label-ai-cleanup-apply")
        : undefined}
      primaryDisabled={diffSelectedCount === 0 || applying}
      onPrimary={apply}
    />
  {/snippet}
</AppDialog>
