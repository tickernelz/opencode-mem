<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ListFilter from "@lucide/svelte/icons/list-filter";
  import Button from "$lib/components/ui/button.svelte";
  import { FIELD_INPUT, GAP, ICON_SM, ICON_XS } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type TagOption = { tag: string; displayName?: string };

  type Props = {
    tags: TagOption[];
    value?: string[];
    allLabel: string;
    filterLabel?: string;
    clearLabel?: string;
    searchPlaceholder?: string;
    onChange: (value: string[]) => void;
  };

  let {
    tags,
    value = [],
    allLabel,
    filterLabel = "Filter",
    clearLabel = "Clear selection",
    searchPlaceholder = "Filter…",
    onChange,
  }: Props = $props();

  let open = $state(false);
  let query = $state("");
  let root: HTMLDivElement | undefined = $state();

  const selected = $derived(new Set(value));
  const active = $derived(selected.size > 0);
  const title = $derived(active ? `${filterLabel} · ${selected.size}` : filterLabel);
  const needle = $derived(query.trim().toLowerCase());
  const visible = $derived(
    tags.filter((tag) => {
      if (!needle) return true;
      const label = (tag.displayName || tag.tag).toLowerCase();
      return label.includes(needle) || tag.tag.toLowerCase().includes(needle);
    })
  );

  function clear() {
    onChange([]);
  }

  function toggle(tag: string) {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange([...next]);
  }

  $effect(() => {
    if (!open) {
      query = "";
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") open = false;
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="relative shrink-0" bind:this={root}>
  <Button
    type="button"
    variant="outline"
    class={cn(active && "border-primary/50 text-primary")}
    aria-expanded={open}
    aria-haspopup="dialog"
    aria-label={title}
    {title}
    onclick={() => (open = !open)}
  >
    <ListFilter class={ICON_SM} aria-hidden="true" />
    <span>{filterLabel}</span>
    {#if active}
      <span
        class="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground"
      >
        {selected.size}
      </span>
    {/if}
    <ChevronDown
      class={cn(
        ICON_SM,
        "transition-transform motion-reduce:transition-none",
        open && "rotate-180"
      )}
      aria-hidden="true"
    />
  </Button>

  {#if open}
    <div
      class="absolute inset-s-0 top-[calc(100%+0.35rem)] z-50 w-64 origin-top-left overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none"
      role="menu"
      tabindex="-1"
      aria-label={filterLabel}
      onpointerdown={(e) => e.stopPropagation()}
    >
      <div class="p-2">
        <input
          bind:value={query}
          class={cn(FIELD_INPUT, "mb-2")}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        <div class="bg-border -mx-2 my-1 h-px" aria-hidden="true"></div>
        <div class="relative h-64 overflow-y-auto scrollbar-thin">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={!active}
            class={cn(
              "flex w-full cursor-pointer items-center px-2 py-2 text-left text-sm hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
              GAP
            )}
            onclick={clear}
          >
            <span
              class={cn(
                "inline-flex size-4 shrink-0 items-center justify-center rounded-lg border shadow-xs",
                !active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-transparent"
              )}
              aria-hidden="true"
            >
              {#if !active}
                <Check class={ICON_XS} aria-hidden="true" />
              {/if}
            </span>
            <span class="min-w-0 flex-1 truncate font-normal">{allLabel}</span>
          </button>

          {#each visible as tag (tag.tag)}
            {@const on = selected.has(tag.tag)}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              class={cn(
                "flex w-full cursor-pointer items-center px-2 py-2 text-left text-sm hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
                GAP
              )}
              onclick={() => toggle(tag.tag)}
            >
              <span
                class={cn(
                  "inline-flex size-4 shrink-0 items-center justify-center rounded-lg border shadow-xs",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-transparent"
                )}
                aria-hidden="true"
              >
                {#if on}
                  <Check class={ICON_XS} aria-hidden="true" />
                {/if}
              </span>
              <span class="min-w-0 flex-1 truncate font-normal">{tag.displayName || tag.tag}</span>
            </button>
          {:else}
            <p class="px-2 py-6 text-center text-sm text-muted-foreground">—</p>
          {/each}
        </div>
        <div class="bg-border -mx-2 my-1 h-px" aria-hidden="true"></div>
        <Button
          type="button"
          variant="outline"
          class="mt-2 w-full"
          disabled={!active}
          onclick={clear}
        >
          {clearLabel}
        </Button>
      </div>
    </div>
  {/if}
</div>
