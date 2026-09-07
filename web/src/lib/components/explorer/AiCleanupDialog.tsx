import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GitMerge,
  Loader,
  Target,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { fetchAPI } from "$lib/api";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "$lib/components/ui/dialog";
import { useI18n } from "$lib/i18n";
import { findDescById, findStepsById } from "$lib/profile-utils";
import type { PendingCleanup, ProfileItem, UserProfile } from "$lib/types";

type CleanupItem = ProfileItem & { _id: string; _type: "pref" | "pat" | "wf" };

type Props = {
  open?: boolean;
  profile?: UserProfile | null;
  onOpenChange?: (open: boolean) => void;
  onApplied?: () => void;
};

function truncate(text: string, max: number) {
  return text.length > max ? text.substring(0, max) + "..." : text;
}

export function AiCleanupDialog({ open = false, profile = null, onOpenChange, onApplied }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"select" | "loading" | "diff">("select");
  const [allItems, setAllItems] = useState<CleanupItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingCleanup, setPendingCleanup] = useState<PendingCleanup | null>(null);
  const [acceptedMerged, setAcceptedMerged] = useState<Set<number>>(new Set());
  const [acceptedRemoved, setAcceptedRemoved] = useState<Set<number>>(new Set());
  const [keptOpen, setKeptOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const wasOpen = useRef(false);

  const cats = useMemo(() => {
    const map: Record<string, { pref: CleanupItem[]; pat: CleanupItem[]; wf: CleanupItem[] }> = {};
    for (const it of allItems) {
      const cat = it.category || "(none)";
      if (!map[cat]) map[cat] = { pref: [], pat: [], wf: [] };
      map[cat][it._type].push(it);
    }
    return map;
  }, [allItems]);

  const sortedCatKeys = useMemo(() => Object.keys(cats).sort(), [cats]);
  const selectedCount = selectedIds.size;
  const diffSelectedCount = acceptedMerged.size + acceptedRemoved.size;
  const diffTotalCount =
    (pendingCleanup?.changes.merged?.length || 0) + (pendingCleanup?.changes.removed?.length || 0);

  function initSelect() {
    const pd = profile?.profileData;
    if (!pd) {
      toast.error("No profile data loaded");
      handleOpenChange(false);
      return;
    }

    const prefs = (pd.preferences || []).map((p, i) => ({
      ...p,
      _id: `pref_${i}`,
      _type: "pref" as const,
    }));
    const pats = (pd.patterns || []).map((p, i) => ({
      ...p,
      _id: `pat_${i}`,
      _type: "pat" as const,
    }));
    const wfs = (pd.workflows || []).map((w, i) => ({
      ...w,
      _id: `wf_${i}`,
      _type: "wf" as const,
    }));
    const items = [...prefs, ...pats, ...wfs];
    setAllItems(items);
    setSelectedIds(new Set(items.filter((it) => (it.frequency || 0) <= 3).map((it) => it._id)));
    setPhase("select");
    setPendingCleanup(null);
    setKeptOpen(false);
  }

  useEffect(() => {
    if (open && !wasOpen.current) {
      initSelect();
    } else if (!open && wasOpen.current) {
      setPhase("select");
      setPendingCleanup(null);
      setApplying(false);
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-init on dialog open edge
  }, [open]);

  function handleOpenChange(next: boolean) {
    onOpenChange?.(next);
  }

  function toggleId(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(allItems.map((it) => it._id)));
  }

  function selectNone() {
    setSelectedIds(new Set());
  }

  function selectLow() {
    setSelectedIds(new Set(allItems.filter((it) => (it.frequency || 0) <= 3).map((it) => it._id)));
  }

  function selectSameCat() {
    const next = new Set<string>();
    for (const cat of Object.keys(cats)) {
      const items = [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf];
      if (items.length >= 3) {
        for (const it of items) next.add(it._id);
      }
    }
    setSelectedIds(next);
  }

  async function analyze() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      toast.warning("No items selected");
      return;
    }
    setPhase("loading");
    const result = await fetchAPI<PendingCleanup>("/api/user-profile/ai-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ includeIds: ids, profileVersion: profile?.version }),
      timeout: 180000,
    });
    if (!result.success || !result.data) {
      setPhase("select");
      toast.error(result.error || t("toast-ai-cleanup-failed"));
      return;
    }
    setPendingCleanup(result.data);
    setAcceptedMerged(new Set((result.data.changes.merged || []).map((_, i) => i)));
    setAcceptedRemoved(new Set((result.data.changes.removed || []).map((_, i) => i)));
    setPhase("diff");
  }

  function typeLabel(id: string) {
    if (!id.includes("_")) return "?";
    const prefix = id.split("_")[0];
    if (prefix === "pref") return t("profile-type-pref") || "Pref";
    if (prefix === "pat") return t("profile-type-pat") || "Pat";
    if (prefix === "wf") return t("profile-type-wf") || "Wf";
    return "?";
  }

  function toggleMerged(i: number, checked: boolean) {
    setAcceptedMerged((prev) => {
      const next = new Set(prev);
      if (checked) next.add(i);
      else next.delete(i);
      return next;
    });
  }

  function toggleRemoved(i: number, checked: boolean) {
    setAcceptedRemoved((prev) => {
      const next = new Set(prev);
      if (checked) next.add(i);
      else next.delete(i);
      return next;
    });
  }

  function selectAllDiff() {
    setAcceptedMerged(new Set((pendingCleanup?.changes.merged || []).map((_, i) => i)));
    setAcceptedRemoved(new Set((pendingCleanup?.changes.removed || []).map((_, i) => i)));
  }

  function deselectAllDiff() {
    setAcceptedMerged(new Set());
    setAcceptedRemoved(new Set());
  }

  async function apply() {
    if (!pendingCleanup || diffSelectedCount === 0) return;
    setApplying(true);
    const acceptedMergedIds = [...acceptedMerged]
      .map((mi) => pendingCleanup?.changes.merged?.[mi]?.ids)
      .filter((ids): ids is string[] => !!ids);
    const acceptedRemovedIds = [...acceptedRemoved]
      .map((ri) => pendingCleanup?.changes.removed?.[ri]?.id)
      .filter((id): id is string => !!id);

    const result = await fetchAPI("/api/user-profile/ai-cleanup/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: pendingCleanup.new,
        acceptedMerged: acceptedMergedIds,
        acceptedRemoved: acceptedRemovedIds,
      }),
    });
    setApplying(false);

    if (result.success) {
      toast.success(t("toast-ai-cleanup-success"));
      handleOpenChange(false);
      onApplied?.();
    } else {
      toast.error(result.error || t("toast-cleanup-apply-failed"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="grid! sm:max-w-2xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden gap-4">
        <DialogHeader>
          <DialogTitle>{t("label-ai-cleanup-title")}</DialogTitle>
        </DialogHeader>

        {phase === "loading" ? (
          <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
            <Loader className="size-6 animate-spin" />
            <span className="text-sm">{t("label-ai-cleanup-loading")}</span>
          </div>
        ) : phase === "select" ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t("label-ai-cleanup-select")}</h3>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="secondary" size="xs" onClick={selectAll}>
                  {t("label-ai-cleanup-select-all")}
                </Button>
                <Button variant="secondary" size="xs" onClick={selectNone}>
                  {t("label-ai-cleanup-deselect-all")}
                </Button>
                <Button variant="secondary" size="xs" onClick={selectLow}>
                  {t("label-ai-cleanup-select-low")}
                </Button>
                <Button variant="secondary" size="xs" onClick={selectSameCat}>
                  {t("label-ai-cleanup-select-same-cat")}
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {sortedCatKeys.map((cat) => {
                const items = [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf];
                return (
                  <div key={cat} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs rounded-full bg-muted px-2 py-0.5">{cat}</span>
                      <span className="text-xs text-muted-foreground">{items.length} items</span>
                    </div>
                    {items.map((it) => {
                      const checked = selectedIds.has(it._id);
                      return (
                        <div
                          key={it._id}
                          className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/40"
                          role="checkbox"
                          aria-checked={checked}
                          tabIndex={0}
                          onClick={() => toggleId(it._id, !checked)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleId(it._id, !checked);
                            }
                          }}
                        >
                          <span className="pointer-events-none inline-flex">
                            <Checkbox checked={checked} tabIndex={-1} />
                          </span>
                          <span className="text-[10px] font-medium text-muted-foreground w-4">
                            {it._type === "pref" ? "P" : it._type === "pat" ? "T" : "W"}
                          </span>
                          <span className="flex-1 truncate">
                            {(it.description || "").substring(0, 80)}
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                            <Target className="size-3" />
                            {it.frequency || 0}
                            {it.confidence != null ? ` | ${Math.round(it.confidence * 100)}%` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">
                {t("label-ai-cleanup-selected", { count: selectedCount })}
              </span>
              <Button onClick={analyze}>{t("label-ai-cleanup-analyze")}</Button>
            </div>
          </div>
        ) : phase === "diff" && pendingCleanup ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t("label-ai-cleanup-changes-selected", {
                  selected: diffSelectedCount,
                  total: diffTotalCount,
                })}
              </span>
              <div className="flex gap-2">
                <Button variant="link" size="xs" onClick={selectAllDiff}>
                  {t("label-ai-cleanup-select-all")}
                </Button>
                <Button variant="link" size="xs" onClick={deselectAllDiff}>
                  {t("label-ai-cleanup-deselect-all")}
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {(pendingCleanup.changes.merged || []).length > 0 ? (
                <div className="space-y-2">
                  <h4 className="flex items-center gap-1.5 text-sm font-medium">
                    <GitMerge className="size-3.5" />
                    {t("label-ai-cleanup-merged-header", {
                      count: pendingCleanup.changes.merged?.length || 0,
                    })}
                  </h4>
                  {(pendingCleanup.changes.merged || []).map((m, mi) => {
                    const mergedFrom = m.ids.slice(1);
                    const mainDesc = m.result || "";
                    const mainSteps = findStepsById(m.ids[0], pendingCleanup.old);
                    const mergeChecked = acceptedMerged.has(mi);
                    return (
                      <div key={mi} className="rounded-xl border border-border p-3 space-y-2">
                        <div
                          className="flex items-center gap-2 text-sm cursor-pointer"
                          role="checkbox"
                          aria-checked={mergeChecked}
                          tabIndex={0}
                          onClick={() => toggleMerged(mi, !mergeChecked)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleMerged(mi, !mergeChecked);
                            }
                          }}
                        >
                          <span className="pointer-events-none inline-flex">
                            <Checkbox checked={mergeChecked} tabIndex={-1} />
                          </span>
                          <span>{t("label-ai-cleanup-merge-check")}</span>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] items-start text-sm">
                          <div className="space-y-1.5">
                            {mergedFrom.map((id) => {
                              const desc = findDescById(id, pendingCleanup.old);
                              const steps = findStepsById(id, pendingCleanup.old);
                              if (!desc) return null;
                              return (
                                <div key={id} className="rounded-lg bg-muted/50 p-2 space-y-1">
                                  <div>
                                    <span className="text-[10px] rounded bg-muted px-1.5 py-0.5">
                                      {typeLabel(id)}
                                    </span>{" "}
                                    {truncate(desc, 80)}
                                  </div>
                                  {steps?.length ? (
                                    <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                                      {steps.map((s, si) => (
                                        <span key={si} className="contents">
                                          <span>
                                            {si + 1}. {s}
                                          </span>
                                          {si < steps.length - 1 ? (
                                            <ArrowRight className="size-3 inline" />
                                          ) : null}
                                        </span>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                          <div className="text-muted-foreground self-center grid place-items-center">
                            <ChevronRight className="size-4" />
                          </div>
                          <div className="rounded-lg bg-primary/10 p-2 space-y-1">
                            <div>{truncate(mainDesc, 120)}</div>
                            {mainSteps?.length ? (
                              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                                {mainSteps.map((s, si) => (
                                  <span key={si} className="contents">
                                    <span>
                                      {si + 1}. {s}
                                    </span>
                                    {si < mainSteps.length - 1 ? (
                                      <ArrowRight className="size-3 inline" />
                                    ) : null}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {(pendingCleanup.changes.removed || []).length > 0 ? (
                <div className="space-y-2">
                  <h4 className="flex items-center gap-1.5 text-sm font-medium">
                    <Trash2 className="size-3.5" />
                    {t("label-ai-cleanup-removed-header", {
                      count: pendingCleanup.changes.removed?.length || 0,
                    })}
                  </h4>
                  {(pendingCleanup.changes.removed || []).map((r, ri) => {
                    const desc = findDescById(r.id, pendingCleanup.old);
                    const steps = findStepsById(r.id, pendingCleanup.old);
                    const removeChecked = acceptedRemoved.has(ri);
                    return (
                      <div key={ri} className="rounded-xl border border-border p-3 space-y-2">
                        <div
                          className="flex items-center gap-2 text-sm cursor-pointer"
                          role="checkbox"
                          aria-checked={removeChecked}
                          tabIndex={0}
                          onClick={() => toggleRemoved(ri, !removeChecked)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleRemoved(ri, !removeChecked);
                            }
                          }}
                        >
                          <span className="pointer-events-none inline-flex">
                            <Checkbox checked={removeChecked} tabIndex={-1} />
                          </span>
                          <span>{t("label-ai-cleanup-remove-check")}</span>
                        </div>
                        <div className="text-sm">{desc || r.id}</div>
                        {steps?.length ? (
                          <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                            {steps.map((s, si) => (
                              <span key={si} className="contents">
                                <span>
                                  {si + 1}. {s}
                                </span>
                                {si < steps.length - 1 ? (
                                  <ArrowRight className="size-3 inline" />
                                ) : null}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="text-xs text-muted-foreground">{r.reason}</div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {(pendingCleanup.changes.kept || []).length > 0 ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-sm font-medium"
                    onClick={() => setKeptOpen((v) => !v)}
                  >
                    {t("label-ai-cleanup-kept")}
                    <span className="text-muted-foreground">
                      ({pendingCleanup.changes.kept?.length || 0})
                    </span>
                    {keptOpen ? (
                      <ChevronUp className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                  </button>
                  {keptOpen ? (
                    <div className="space-y-1">
                      {(pendingCleanup.changes.kept || []).map((k, ki) => (
                        <div
                          key={ki}
                          className="text-xs text-muted-foreground rounded bg-muted/40 px-2 py-1"
                        >
                          {k}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={() => handleOpenChange(false)}>
            {t("btn-cancel")}
          </Button>
          {phase === "diff" ? (
            <Button disabled={diffSelectedCount === 0 || applying} onClick={apply}>
              {diffSelectedCount > 0
                ? `${t("label-ai-cleanup-apply")} (${diffSelectedCount})`
                : t("label-ai-cleanup-apply") || "Apply"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
