<script lang="ts">
  import ToastCard from "./toast-card.svelte";
  import { dismissToast, toastState } from "$lib/toast/toast.svelte";
  import type { ToastItem } from "$lib/toast/toastStack";
  import { cn } from "$lib/utils";

  const STACK_PEEK = 12;
  const STACK_SCALE = 0.05;
  const FRONT_HEIGHT_REM = 3.75;

  let {
    toasts,
    onDismiss,
  }: {
    toasts?: ToastItem[];
    onDismiss?: (id: string) => void;
  } = $props();

  const items = $derived(toasts ?? toastState.items);
  const dismiss = $derived(onDismiss ?? dismissToast);

  let expanded = $state(false);
  const ordered = $derived([...items].reverse());
  const visibleBehind = $derived(Math.min(Math.max(ordered.length - 1, 0), 2));

  function openStack() {
    expanded = true;
  }

  function closeStack(event: FocusEvent | MouseEvent) {
    const next = "relatedTarget" in event ? event.relatedTarget : null;
    if (
      next instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(next)
    ) {
      return;
    }
    expanded = false;
  }
</script>

{#if items.length > 0}
  <div
    role="region"
    aria-label="Notifications"
    aria-relevant="additions"
    class="pointer-events-none fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-50 sm:left-auto sm:w-88"
  >
    <div
      role="group"
      class={cn(
        "pointer-events-auto relative w-full transition-[height] duration-300 ease-out",
        expanded && "flex flex-col-reverse gap-2"
      )}
      style={expanded
        ? undefined
        : `height: calc(${FRONT_HEIGHT_REM}rem + ${visibleBehind * STACK_PEEK}px)`}
      onmouseenter={openStack}
      onmouseleave={closeStack}
      onfocusin={openStack}
      onfocusout={closeStack}
    >
      {#each ordered as item, index (item.id)}
        {@const front = index === 0}
        {@const behind = Math.min(index, 2)}
        {@const hiddenBehind = !expanded && index > 2}
        {#if expanded}
          <div class="w-full transition-[transform,opacity] duration-300 ease-out">
            <ToastCard {item} onDismiss={dismiss} />
          </div>
        {:else}
          <div
            aria-hidden={!front}
            class={cn(
              "absolute right-0 bottom-0 left-0 origin-bottom transition-[transform,opacity] duration-300 ease-out",
              front && "animate-[toast-in_180ms_ease-out]",
              hiddenBehind && "pointer-events-none opacity-0"
            )}
            style="z-index: {ordered.length - index}; transform: translateY(-{behind *
              STACK_PEEK}px) scale({1 - behind * STACK_SCALE})"
          >
            <ToastCard {item} onDismiss={dismiss} dimmed={!front} />
          </div>
        {/if}
      {/each}
    </div>
  </div>
{/if}
