<script lang="ts">
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
  import { GAP, GAP_LOOSE, ICON, ICON_SM, STACK } from "$lib/ui/styles";
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
  <div class={cn("flex flex-wrap items-center justify-end", GAP_LOOSE)}>
    <Button
      variant="default"
      size="icon"
      aria-label={i18n.t("btn-add-skill")}
      title={i18n.t("btn-add-skill")}
      onclick={onCreate}
    >
      <Plus class={ICON} aria-hidden="true" />
    </Button>
  </div>

  <div class={cn(STACK, "min-h-32")}>
    {#if loading && skills.length === 0}
      <EmptyState>{i18n.t("loading-init")}</EmptyState>
    {:else if skills.length === 0}
      <div class={cn("flex flex-col items-center py-10 text-muted-foreground", GAP)}>
        <Sparkles class="size-8" aria-hidden="true" />
        <p class="text-sm">{i18n.t("skill-empty")}</p>
      </div>
    {:else}
      <ul class="space-y-2">
        {#each skills as skill (skill.id)}
          <li
            class="rounded-xl border border-border bg-card p-4 transition-colors hover:bg-card/80"
          >
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
  </div>
</section>
