<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import type { HTMLInputAttributes } from "svelte/elements";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { FIELD_INPUT, HOVER_SURFACE, ICON, ICON_BTN_DENSE } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    value?: string;
    placeholder: string;
    id?: string;
    class?: string;
    showClear?: boolean;
    onClear?: () => void;
    onSearch?: () => void;
    onkeydown?: HTMLInputAttributes["onkeydown"];
  };

  let {
    value = $bindable(""),
    placeholder,
    id,
    class: className = "max-w-xl",
    showClear = false,
    onClear,
    onSearch,
    onkeydown,
  }: Props = $props();

  const i18n = useI18n();

  function handleSearch(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    onSearch?.();
    const form = event.currentTarget.closest("form");
    if (form) form.requestSubmit();
  }
</script>

<div class={cn("relative min-w-0 w-full", className)}>
  <input
    {id}
    class={cn(FIELD_INPUT, "placeholder:text-muted-foreground", showClear ? "pr-18" : "pr-11")}
    bind:value
    {placeholder}
    aria-label={placeholder}
    {onkeydown}
  />
  {#if showClear}
    <button
      type="button"
      class={cn(
        "absolute top-1/2 right-10 inline-flex -translate-y-1/2 items-center justify-center text-muted-foreground transition-[color,transform] active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 focus-ring",
        ICON_BTN_DENSE,
        HOVER_SURFACE
      )}
      aria-label={i18n.t("btn-clear")}
      onclick={() => onClear?.()}
    >
      <X class={ICON} aria-hidden="true" />
    </button>
  {/if}
  <button
    type="button"
    class={cn(
      "absolute top-1/2 right-1 inline-flex -translate-y-1/2 items-center justify-center text-muted-foreground transition-[color,transform] active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 focus-ring",
      ICON_BTN_DENSE,
      HOVER_SURFACE
    )}
    aria-label={i18n.t("label-search")}
    title={i18n.t("label-search")}
    onclick={handleSearch}
  >
    <Search class={ICON} aria-hidden="true" />
  </button>
</div>
