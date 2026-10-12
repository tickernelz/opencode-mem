<script lang="ts">
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import MessageCircle from "@lucide/svelte/icons/message-circle";
  import MemoryActions from "./MemoryActions.svelte";
  import Checkbox from "$lib/components/ui/checkbox.svelte";
  import TagsField from "$lib/components/ui/tags-field.svelte";
  import { formatDate } from "$lib/format";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import {
    dateInfo,
    displayInfo,
    CARD_TITLE,
    memoryCardClass,
    similarityLabel,
  } from "$lib/memory-display";
  import type { MemoryItem } from "$lib/types";
  import { GAP, GAP_LOOSE, GAP_TIGHT, ICON_SM, STACK_TIGHT } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    variant: "memory" | "prompt" | "pair";
    item?: MemoryItem;
    memory?: MemoryItem;
    prompt?: MemoryItem;
    selected?: boolean;
    knownTags?: string[];
    onSelect?: (id: string, selected: boolean) => void;
    onPin?: (id: string) => void;
    onUnpin?: (id: string) => void;
    onEdit?: (id: string) => void;
    onDeleteMemory?: (id: string, isLinked: boolean) => void;
    onDeletePrompt?: (id: string, isLinked: boolean) => void;
    onTagsChange?: (id: string, tags: string[]) => void;
  };

  let {
    variant,
    item,
    memory,
    prompt,
    selected = false,
    knownTags = [],
    onSelect,
    onPin,
    onUnpin,
    onEdit,
    onDeleteMemory,
    onDeletePrompt,
    onTagsChange,
  }: Props = $props();

  const i18n = useI18n();

  const pairPinned = $derived(memory?.isPinned || false);
  const pairDates = $derived(memory ? dateInfo(memory) : null);
  const pairSim = $derived(memory ? similarityLabel(memory, true) : null);
  const promptIsLinked = $derived(!!item?.linkedMemoryId);
  const memoryPinned = $derived(item?.isPinned || false);
  const memoryIsLinked = $derived(!!item?.linkedPromptId);
  const memoryDates = $derived(item ? dateInfo(item) : null);
  const memorySim = $derived(item ? similarityLabel(item, false) : null);
</script>

{#snippet tagsRow(tags: string[] | undefined, memoryId?: string)}
  <TagsField
    value={tags || []}
    suggestions={knownTags}
    placeholder={i18n.t("placeholder-new-tag")}
    addLabel={i18n.t("btn-add-tag")}
    onChange={(next) => {
      if (memoryId) onTagsChange?.(memoryId, next);
    }}
  />
{/snippet}

{#snippet markdownBody(content: string)}
  <div class="markdown-content text-sm prose-invert max-w-none">
    {@html renderMarkdown(content)}
  </div>
{/snippet}

{#snippet dateMeta(dates: { createdDate: string; updatedDate: string | null }, id: string)}
  <div class={cn("flex flex-wrap text-xs text-muted-foreground", GAP_LOOSE)}>
    <span>{i18n.t("date-created")} {dates.createdDate}</span>
    {#if dates.updatedDate}
      <span>{i18n.t("date-updated")} {dates.updatedDate}</span>
    {/if}
    <span>ID: {id}</span>
  </div>
{/snippet}

{#snippet linkedHint(direction: "up" | "down", label: string)}
  <div class={cn("flex items-center text-xs text-muted-foreground", "gap-1")}>
    {#if direction === "up"}
      <ArrowUp class={ICON_SM} />
      {label}
      <ArrowDown class={ICON_SM} />
    {:else}
      <ArrowDown class={ICON_SM} />
      {label}
      <ArrowUp class={ICON_SM} />
    {/if}
  </div>
{/snippet}

{#snippet headerRow(
  id: string,
  title: string,
  projectLabel: string | null,
  opts: {
    selected: boolean;
    pinned?: boolean;
    isLinked: boolean;
    deleteLabel: string;
    showPinEdit?: boolean;
    linkedHint?: string;
    onDelete?: (id: string, isLinked: boolean) => void;
  }
)}
  <div class={cn("flex items-center", GAP)}>
    <Checkbox
      checked={opts.selected}
      onCheckedChange={(v) => onSelect?.(id, v === true)}
      class="shrink-0"
      aria-label={`Select ${title}`}
    />
    <h3 class={cn(CARD_TITLE, "min-w-0 flex-1")}>
      <span class="truncate">{title}</span>
      {#if projectLabel}
        <span class="font-normal text-muted-foreground">·</span>
        <span class="truncate font-normal text-muted-foreground" title={projectLabel}>
          {projectLabel}
        </span>
      {/if}
      {#if opts.linkedHint}
        <span class="font-normal text-muted-foreground">· {opts.linkedHint}</span>
      {/if}
    </h3>
    <MemoryActions
      {id}
      pinned={opts.pinned}
      isLinked={opts.isLinked}
      deleteLabel={opts.deleteLabel}
      showPinEdit={opts.showPinEdit}
      {onPin}
      {onUnpin}
      {onEdit}
      onDelete={opts.onDelete}
    />
  </div>
{/snippet}

{#if variant === "pair" && memory && prompt && pairDates}
  <div
    class={memoryCardClass({ selected, pinned: pairPinned, spaced: "loose" })}
    data-id={memory.id}
  >
    {@render headerRow(
      memory.id,
      memory.memoryType || i18n.t("badge-memory"),
      displayInfo(memory),
      {
        selected,
        pinned: pairPinned,
        isLinked: true,
        deleteLabel: i18n.t("btn-delete-pair"),
        onDelete: onDeleteMemory,
      }
    )}
    {#if pairSim}
      <div class="text-xs text-muted-foreground tabular-nums">{pairSim}</div>
    {/if}
    {@render tagsRow(memory.tags, memory.id)}
    {@render markdownBody(memory.content)}

    <div class={cn(STACK_TIGHT, "rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5")}>
      <div class={cn("flex items-center text-xs text-muted-foreground", GAP_TIGHT)}>
        <MessageCircle class={cn(ICON_SM, "shrink-0")} />
        <span class="font-medium text-foreground/80">{i18n.t("badge-prompt")}</span>
        <span>·</span>
        <span>{formatDate(prompt.createdAt)}</span>
      </div>
      <p class="text-sm whitespace-pre-wrap wrap-break-word text-muted-foreground">
        {prompt.content}
      </p>
    </div>

    {@render dateMeta(pairDates, memory.id)}
  </div>
{:else if variant === "prompt" && item}
  <div class={memoryCardClass({ selected })} data-id={item.id}>
    {@render headerRow(item.id, i18n.t("badge-prompt"), displayInfo(item), {
      selected,
      isLinked: promptIsLinked,
      deleteLabel: promptIsLinked ? i18n.t("btn-delete-pair") : i18n.t("btn-delete"),
      showPinEdit: false,
      linkedHint: promptIsLinked ? i18n.t("badge-linked") : undefined,
      onDelete: onDeletePrompt,
    })}
    <div class={cn("flex flex-wrap items-center text-xs text-muted-foreground", GAP_TIGHT)}>
      <MessageCircle class={ICON_SM} />
      <span>{formatDate(item.createdAt)}</span>
    </div>
    <p class="text-sm whitespace-pre-wrap wrap-break-word">{item.content}</p>
    {#if promptIsLinked}
      {@render linkedHint("down", i18n.t("text-generated-above"))}
    {/if}
  </div>
{:else if variant === "memory" && item && memoryDates}
  <div class={memoryCardClass({ selected, pinned: memoryPinned })} data-id={item.id}>
    {@render headerRow(item.id, item.memoryType || i18n.t("badge-memory"), displayInfo(item), {
      selected,
      pinned: memoryPinned,
      isLinked: memoryIsLinked,
      deleteLabel: memoryIsLinked ? i18n.t("btn-delete-pair") : i18n.t("btn-delete"),
      linkedHint: memoryIsLinked ? i18n.t("badge-linked") : undefined,
      onDelete: onDeleteMemory,
    })}
    {#if memorySim}
      <div class="text-xs text-muted-foreground tabular-nums">{memorySim}</div>
    {/if}
    {@render tagsRow(item.tags, item.id)}
    {@render markdownBody(item.content)}
    {#if memoryIsLinked}
      {@render linkedHint("up", i18n.t("text-from-below"))}
    {/if}
    {@render dateMeta(memoryDates, item.id)}
  </div>
{/if}
