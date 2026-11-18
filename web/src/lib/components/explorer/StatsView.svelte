<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Alert from "$lib/components/ui/alert.svelte";
  import AlertDescription from "$lib/components/ui/alert-description.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import EmptyState from "$lib/components/ui/empty-state.svelte";
  import { formatDate } from "$lib/format";
  import { useI18n } from "$lib/i18n/context.svelte";
  import type { StatsData, StatsDaily } from "$lib/stores/stats.svelte";
  import {
    CARD_PAD,
    GAP,
    ICON_SM,
    META_CHIP,
    STACK,
    STACK_SECTION,
    SURFACE_CARD,
  } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    data: StatsData | null;
    loading?: boolean;
    error?: string | null;
    onRefresh?: () => void;
  };

  let { data, loading = false, error = null, onRefresh }: Props = $props();
  const i18n = useI18n();
  const metrics = [
    { field: "captures", label: "stats-captures", color: "var(--chart-1)" },
    { field: "captureSkipped", label: "stats-skipped", color: "var(--chart-2)" },
    { field: "profileInjections", label: "stats-profile-injections", color: "var(--chart-3)" },
    {
      field: "compactionInjections",
      label: "stats-compaction-injections",
      color: "var(--chart-4)",
    },
  ] as const;
  const daily = $derived(data?.daily ?? []);
  const shards = $derived(
    [...(data?.shards ?? [])].sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) ||
        b.memoryCount - a.memoryCount ||
        a.shardIndex - b.shardIndex
    )
  );
  const peak = $derived(
    Math.max(1, ...daily.flatMap((day) => metrics.map(({ field }) => day[field])))
  );

  function errorBuckets(day: StatsDaily) {
    return Object.entries(day.errors ?? {})
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b));
  }

  function date(value: string | null | undefined) {
    return value ? formatDate(value) : "—";
  }
</script>

<div class={STACK_SECTION} aria-busy={loading}>
  <div class={cn("flex flex-wrap items-center justify-end", GAP)}>
    <Button type="button" variant="outline" disabled={loading} onclick={() => onRefresh?.()}>
      <RefreshCw
        class={cn(ICON_SM, loading && "animate-spin motion-reduce:animate-none")}
        aria-hidden="true"
      />
      {i18n.t("btn-refresh")}
    </Button>
  </div>

  {#if error !== null}
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertDescription class="break-words">
        <p>{i18n.t("stats-load-failed")}</p>
        {#if error}<p>{error}</p>{/if}
        {#if data}<p>{i18n.t("stats-stale")}</p>{/if}
      </AlertDescription>
    </Alert>
  {/if}

  {#if loading && !data}
    <EmptyState>{i18n.t("stats-loading")}</EmptyState>
  {:else if data}
    <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={i18n.t("stats-overview")}>
      <div class={cn(SURFACE_CARD, CARD_PAD, STACK)}>
        <h2 class="text-sm text-muted-foreground">{i18n.t("stats-total-memories")}</h2>
        <p class="text-3xl font-semibold tabular-nums text-foreground-bright">{data.total}</p>
        <p class="text-xs text-muted-foreground">
          {i18n.t("stats-scope-user")}: {data.byScope?.user ?? "—"} · {i18n.t(
            "stats-scope-project"
          )}: {data.byScope?.project ?? "—"}
        </p>
      </div>
      <div class={cn(SURFACE_CARD, CARD_PAD, STACK)}>
        <h2 class="text-sm text-muted-foreground">{i18n.t("stats-active-shards")}</h2>
        <p class="text-3xl font-semibold tabular-nums text-foreground-bright">
          {data.shards ? shards.filter((shard) => shard.isActive).length : "—"}
        </p>
        <p class="text-xs text-muted-foreground">
          {data.shards
            ? i18n.t("text-total", { count: shards.length })
            : i18n.t("stats-unavailable")}
        </p>
      </div>
      <div class={cn(SURFACE_CARD, CARD_PAD, STACK)}>
        <h2 class="text-sm text-muted-foreground">{i18n.t("tab-profile")}</h2>
        {#if data.profile?.error || !data.profile}
          <p class="text-sm text-warning">{i18n.t("stats-unavailable")}</p>
          {#if data.profile?.error}<p class="break-words text-xs text-warning">
              {data.profile.error}
            </p>{/if}
        {:else if data.profile.exists}
          <p class="text-xl font-semibold text-foreground-bright">
            {i18n.t("profile-version")}
            {data.profile.version ?? "—"}
          </p>
          <p class="text-xs text-muted-foreground">
            {i18n.t("stats-last-analyzed")}: {date(data.profile.lastAnalyzedAt)}
          </p>
          {#if data.profile.counts}
            <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>{i18n.t("profile-preferences")}</dt>
              <dd class="tabular-nums">{data.profile.counts.preferences}</dd>
              <dt>{i18n.t("profile-patterns")}</dt>
              <dd class="tabular-nums">{data.profile.counts.patterns}</dd>
              <dt>{i18n.t("profile-workflows")}</dt>
              <dd class="tabular-nums">{data.profile.counts.workflows}</dd>
            </dl>
          {/if}
          {#if data.profile.totalPromptsAnalyzed !== undefined}
            <p class="text-xs text-muted-foreground">
              {i18n.t("profile-prompts")}: {data.profile.totalPromptsAnalyzed}
            </p>
          {/if}
        {:else}
          <p class="text-sm text-muted-foreground">{i18n.t("stats-no-profile")}</p>
        {/if}
      </div>
      <div class={cn(SURFACE_CARD, CARD_PAD, STACK)}>
        <h2 class="text-sm text-muted-foreground">{i18n.t("stats-generated")}</h2>
        <p class="text-lg font-medium text-foreground-bright">
          <time datetime={data.generatedAt}>{date(data.generatedAt)}</time>
        </p>
        <p class="text-xs text-muted-foreground">{i18n.t("stats-snapshot-note")}</p>
      </div>
    </section>

    <section class={STACK} aria-labelledby="stats-daily-heading">
      <h2 id="stats-daily-heading" class="text-lg font-semibold text-foreground-bright">
        {i18n.t("stats-daily")}
      </h2>
      {#if data.dailyError}
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription class="break-words">{data.dailyError}</AlertDescription>
        </Alert>
      {:else if !data.daily}
        <EmptyState>{i18n.t("stats-unavailable")}</EmptyState>
      {:else if daily.length === 0}
        <EmptyState>{i18n.t("stats-no-activity")}</EmptyState>
      {:else}
        <div class={cn(SURFACE_CARD, "overflow-x-auto focus-ring")}>
          <table class="w-full text-sm tabular-nums">
            <thead>
              <tr>
                <th scope="col">{i18n.t("stats-date")}</th>
                {#each metrics as metric}<th scope="col">{i18n.t(metric.label)}</th>{/each}
                <th scope="col">{i18n.t("stats-errors")}</th>
              </tr>
            </thead>
            <tbody>
              {#each daily as day (day.date)}
                {@const buckets = errorBuckets(day)}
                <tr>
                  <th scope="row" class="whitespace-nowrap font-normal">
                    <time datetime={day.date}>{day.date}</time>
                  </th>
                  {#each metrics as metric}
                    <td>
                      <div class="flex min-w-24 items-center gap-3">
                        <span class="min-w-7 text-end">{day[metric.field]}</span>
                        <span
                          class="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted"
                          aria-hidden="true"
                        >
                          <span
                            class="block h-full rounded-full"
                            style:width={`${(day[metric.field] / peak) * 100}%`}
                            style:background={metric.color}
                          ></span>
                        </span>
                      </div>
                    </td>
                  {/each}
                  <td>
                    {#if buckets.length}
                      <details class="min-w-24 text-destructive">
                        <summary class="cursor-pointer rounded focus-ring">
                          {buckets.reduce((sum, [, count]) => sum + count, 0)}
                        </summary>
                        <ul class="mt-2 space-y-1 text-xs">
                          {#each buckets as [bucket, count]}<li class="break-words">
                              <bdi>{bucket}</bdi> ×{count}
                            </li>{/each}
                        </ul>
                      </details>
                    {:else}
                      <span
                        class="inline-flex items-center gap-1.5 whitespace-nowrap text-muted-foreground"
                      >
                        <Check class={cn(ICON_SM, "text-primary")} aria-hidden="true" />{i18n.t(
                          "stats-no-errors"
                        )}
                      </span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class={STACK} aria-labelledby="stats-shards-heading">
      <h2 id="stats-shards-heading" class="text-lg font-semibold text-foreground-bright">
        {i18n.t("stats-shards")}
      </h2>
      {#if shards.length}
        <div class={cn(SURFACE_CARD, "overflow-x-auto focus-ring")}>
          <table class="w-full text-sm tabular-nums">
            <thead>
              <tr>
                <th scope="col">{i18n.t("stats-scope")}</th>
                <th scope="col">{i18n.t("stats-file")}</th>
                <th scope="col">{i18n.t("stats-index")}</th>
                <th scope="col">{i18n.t("stats-status")}</th>
                <th scope="col">{i18n.t("stats-memory-vectors")}</th>
                <th scope="col">{i18n.t("stats-memory-dates")}</th>
                <th scope="col">{i18n.t("stats-duplicate-tags")}</th>
              </tr>
            </thead>
            <tbody>
              {#each shards as shard}
                <tr>
                  <td>
                    <p>
                      {i18n.t(shard.scope === "user" ? "stats-scope-user" : "stats-scope-project")}
                    </p>
                    <bdi class="font-mono text-xs text-muted-foreground" title={shard.scopeHash}>
                      {shard.scopeHash.slice(0, 8) || "—"}
                    </bdi>
                  </td>
                  <td class="min-w-40 max-w-64 break-words">
                    <bdi class="text-xs">{shard.fileName}</bdi>
                    <p
                      class={cn(
                        "mt-1 text-xs",
                        shard.fileExists ? "text-muted-foreground" : "font-medium text-warning"
                      )}
                    >
                      {i18n.t(shard.fileExists ? "stats-file-present" : "stats-file-missing")}
                    </p>
                    {#if shard.error}<p class="mt-2 text-xs text-destructive">{shard.error}</p>{/if}
                  </td>
                  <td>{shard.shardIndex}</td>
                  <td>
                    <span class={META_CHIP}>
                      {i18n.t(shard.isActive ? "stats-active" : "stats-inactive")}
                    </span>
                  </td>
                  <td>
                    <p class="whitespace-nowrap">
                      {shard.memoryCount} / {shard.registeredVectorCount}
                    </p>
                    {#if shard.memoryCount !== shard.registeredVectorCount}
                      <p class="mt-1 text-xs font-medium text-warning">
                        {i18n.t("stats-count-mismatch")}
                      </p>
                    {/if}
                  </td>
                  <td class="min-w-44 text-xs text-muted-foreground">
                    <p>{i18n.t("stats-oldest")}: {date(shard.oldestCreatedAt)}</p>
                    <p class="mt-1">{i18n.t("stats-newest")}: {date(shard.newestCreatedAt)}</p>
                  </td>
                  <td
                    class={shard.duplicateTagCount > 0
                      ? "font-medium text-warning"
                      : "text-muted-foreground"}
                  >
                    {shard.duplicateTagCount}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <EmptyState>{i18n.t(data.shards ? "stats-no-shards" : "stats-unavailable")}</EmptyState>
      {/if}
    </section>
  {/if}
</div>

<style>
  th,
  td {
    padding: 0.625rem 0.75rem;
    text-align: start;
    vertical-align: top;
  }

  thead th {
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  tbody tr + tr {
    border-top: 1px solid var(--border);
  }
</style>
