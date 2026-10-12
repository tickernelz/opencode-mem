<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import { GAP, ICON_SM, PANEL } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    title: string;
    class?: string;
    collapsible?: boolean;
    defaultOpen?: boolean;
    leading?: Snippet;
    trailing?: Snippet;
    action?: Snippet;
    children?: Snippet;
  };

  let {
    title,
    class: className,
    collapsible = false,
    defaultOpen = true,
    leading,
    trailing,
    action,
    children,
  }: Props = $props();

  // Initial open only — toggles stay local and must not re-sync from the prop.
  let open = $state(untrack(() => defaultOpen));

  function toggle() {
    if (!collapsible) return;
    open = !open;
  }
</script>

<section class={cn("min-w-0", className)}>
  <div class={cn(PANEL, "[--floating-label-bg:var(--card)]")}>
    {#if collapsible}
      <button
        type="button"
        class={cn("flex w-full items-center min-w-0 text-start", GAP)}
        aria-expanded={open}
        onclick={toggle}
      >
        {#if leading}
          {@render leading()}
        {/if}
        <h2 class="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-foreground-bright">
          {title}
        </h2>
        {#if trailing}
          {@render trailing()}
        {/if}
        {#if action}
          <!-- Stop header toggle when clicking slot actions (icon buttons). -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="shrink-0" onpointerdown={(e) => e.stopPropagation()}>
            {@render action()}
          </div>
        {/if}
        <ChevronDown
          class={cn(
            ICON_SM,
            "shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>
    {:else}
      <div class={cn("flex items-center min-w-0", GAP)}>
        {#if leading}
          {@render leading()}
        {/if}
        <h2 class="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-foreground-bright">
          {title}
        </h2>
        {#if trailing}
          {@render trailing()}
        {/if}
        {#if action}
          <div class="ms-auto shrink-0">{@render action()}</div>
        {/if}
      </div>
    {/if}
    {#if !collapsible || open}
      {@render children?.()}
    {/if}
  </div>
</section>
