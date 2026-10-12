<script lang="ts">
  import Loader from "@lucide/svelte/icons/loader";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plus from "@lucide/svelte/icons/plus";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { SkillItem } from "$lib/stores/skills.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import EmptyState from "$lib/components/ui/empty-state.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { formatDate } from "$lib/format";
  import { GAP_LOOSE, ICON, ICON_SM } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    skills?: SkillItem[];
    loading?: boolean;
    onCreate?: () => void;
    onEdit?: (skill: SkillItem) => void;
    onDelete?: (id: string) => void;
  };

  let { skills = [], loading = false, onCreate, onEdit, onDelete }: Props = $props();

  const i18n = useI18n();
</script>

<section class="space-y-4">
  <div class={cn("flex flex-wrap items-center justify-between", GAP_LOOSE)}>
    <div class="space-y-1">
      <h1 class="text-lg font-medium tracking-tight">
        {i18n.t("section-skills", { count: skills.length })}
      </h1>
      <p class="text-sm text-muted-foreground">{i18n.t("skill-hint")}</p>
    </div>
    <Button onclick={onCreate}>
      <Plus class={ICON_SM} aria-hidden="true" />
      {i18n.t("btn-new-skill")}
    </Button>
  </div>

  {#if loading}
    <div class={cn("flex items-center text-sm text-muted-foreground", GAP_LOOSE)}>
      <Loader class={cn(ICON_SM, "animate-spin")} aria-hidden="true" />
      {i18n.t("loading-init")}
    </div>
  {:else if skills.length === 0}
    <div class="rounded-xl border border-dashed border-border bg-card/50 p-6">
      <div class="mb-3 flex justify-center text-muted-foreground">
        <Sparkles class={ICON} aria-hidden="true" />
      </div>
      <EmptyState>{i18n.t("skill-empty")}</EmptyState>
      <div class="mt-3 flex justify-center">
        <Button variant="secondary" onclick={onCreate}>
          <Plus class={ICON_SM} aria-hidden="true" />
          {i18n.t("btn-add-skill")}
        </Button>
      </div>
    </div>
  {:else}
    <ul class="space-y-2">
      {#each skills as skill (skill.id)}
        <li class="rounded-xl border border-border bg-card p-4 transition-colors hover:bg-card/80">
          <div class={cn("flex flex-wrap items-start justify-between", GAP_LOOSE)}>
            <div class="min-w-0 space-y-1">
              <div class={cn("flex flex-wrap items-center", GAP_LOOSE)}>
                <h2 class="truncate text-sm font-medium">{skill.name}</h2>
                <Badge variant="outline" class="font-mono text-[10px]">{skill.id}</Badge>
                {#if !skill.enabled}
                  <Badge variant="secondary">{i18n.t("skill-disabled")}</Badge>
                {/if}
                {#if skill.autoinvoke}
                  <Badge variant="outline" class="text-[10px]">auto</Badge>
                {/if}
              </div>
              {#if skill.description}
                <p class="text-sm text-muted-foreground">{skill.description}</p>
              {/if}
              <p class="text-xs text-muted-foreground">{formatDate(skill.updatedAt)}</p>
            </div>
            <div class="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={i18n.t("skill-edit")}
                onclick={() => onEdit?.(skill)}
              >
                <Pencil class={ICON_SM} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={i18n.t("confirm-delete-title")}
                onclick={() => onDelete?.(skill.id)}
              >
                <Trash2 class={ICON_SM} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
