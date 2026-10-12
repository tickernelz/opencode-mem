<script lang="ts">
  import PenLine from "@lucide/svelte/icons/pen-line";
  import ScrollText from "@lucide/svelte/icons/scroll-text";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { SkillItem } from "$lib/stores/skills.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import EmptyState from "$lib/components/ui/empty-state.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { formatDate } from "$lib/format";
  import { CARD_TITLE } from "$lib/memory-display";
  import {
    CARD_PAD,
    GAP,
    GAP_TIGHT,
    ICON_SM,
    STACK,
    STACK_TIGHT,
    SURFACE_CARD,
  } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    skills?: SkillItem[];
    filtered?: SkillItem[];
    loading?: boolean;
    onEdit?: (skill: SkillItem) => void;
    onDelete?: (id: string) => void;
  };

  let { skills = [], filtered = skills, loading = false, onEdit, onDelete }: Props = $props();

  const i18n = useI18n();
</script>

<div class={cn(STACK, "min-h-32")}>
  {#if loading && skills.length === 0}
    <EmptyState>{i18n.t("loading-init")}</EmptyState>
  {:else if skills.length === 0}
    <div class={cn("flex flex-col items-center py-10 text-muted-foreground", GAP)}>
      <ScrollText class="size-8" aria-hidden="true" />
      <p class="text-sm">{i18n.t("skill-empty")}</p>
    </div>
  {:else if filtered.length === 0}
    <EmptyState>{i18n.t("skill-empty")}</EmptyState>
  {:else}
    <div class={STACK_TIGHT}>
      {#each filtered as skill (skill.id)}
        <div class={cn(SURFACE_CARD, CARD_PAD, STACK_TIGHT)}>
          <div class={cn("flex items-center", GAP)}>
            <div class={cn("flex min-w-0 flex-1 items-center", GAP)}>
              <h3 class={cn(CARD_TITLE, "min-w-0 truncate")}>{skill.name}</h3>
              {#if !skill.enabled}
                <Badge variant="secondary" class="shrink-0">{i18n.t("skill-disabled")}</Badge>
              {/if}
              {#if skill.autoinvoke}
                <Badge variant="outline" class="shrink-0 text-[10px]">auto</Badge>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                title={i18n.t("btn-edit")}
                aria-label={i18n.t("btn-edit")}
                onclick={() => onEdit?.(skill)}
              >
                <PenLine class={ICON_SM} aria-hidden="true" />
              </Button>
              <Button
                variant="destructive"
                size="icon-xs"
                title={i18n.t("btn-delete")}
                aria-label={i18n.t("btn-delete")}
                onclick={() => onDelete?.(skill.id)}
              >
                <Trash2 class={ICON_SM} aria-hidden="true" />
              </Button>
            </div>
          </div>
          {#if skill.description}
            <p class="text-sm">{skill.description}</p>
          {/if}
          <div class={cn("flex items-center text-xs text-muted-foreground", GAP_TIGHT)}>
            <span>{formatDate(skill.updatedAt)}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
