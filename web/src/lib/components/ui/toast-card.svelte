<script lang="ts">
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import Info from "@lucide/svelte/icons/info";
  import OctagonX from "@lucide/svelte/icons/octagon-x";
  import X from "@lucide/svelte/icons/x";
  import { TOAST_MS, type ToastItem, type ToastVariant } from "$lib/toast/toastStack";
  import { GAP_LOOSE, HOVER_SURFACE, ICON, ICON_SM } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  const styles: Record<ToastVariant, { iconBg: string; iconColor: string; bar: string }> = {
    success: { iconBg: "bg-primary/15", iconColor: "text-primary", bar: "bg-primary/80" },
    error: { iconBg: "bg-destructive/15", iconColor: "text-destructive", bar: "bg-destructive/80" },
    warning: { iconBg: "bg-warning/15", iconColor: "text-warning", bar: "bg-warning/80" },
    info: { iconBg: "bg-muted", iconColor: "text-muted-foreground", bar: "bg-muted-foreground/80" },
  };

  let {
    item,
    onDismiss,
    dimmed = false,
  }: {
    item: ToastItem;
    onDismiss: (id: string) => void;
    dimmed?: boolean;
  } = $props();

  const style = $derived(styles[item.variant]);
  const assertive = $derived(item.variant === "error" || item.variant === "warning");

  $effect(() => {
    const timer = window.setTimeout(() => onDismiss(item.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  });
</script>

<div
  role={assertive ? "alert" : "status"}
  aria-live={assertive ? "assertive" : "polite"}
  class="overflow-hidden rounded-xl border border-border bg-card shadow-[0_12px_40px_rgb(0_0_0/0.45)]"
>
  <div
    class={cn(
      "flex items-center px-3.5 py-3 transition-opacity duration-200",
      GAP_LOOSE,
      dimmed ? "opacity-0" : "opacity-100"
    )}
  >
    <span
      class={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-xl",
        style.iconBg,
        style.iconColor
      )}
    >
      {#if item.variant === "success"}
        <CircleCheck class={ICON} strokeWidth={2.25} aria-hidden="true" />
      {:else if item.variant === "error"}
        <OctagonX class={ICON} strokeWidth={2.25} aria-hidden="true" />
      {:else if item.variant === "warning"}
        <CircleAlert class={ICON} strokeWidth={2.25} aria-hidden="true" />
      {:else}
        <Info class={ICON} strokeWidth={2.25} aria-hidden="true" />
      {/if}
    </span>
    <p class="min-w-0 flex-1 text-sm leading-snug font-medium text-foreground-bright">
      {item.text}
    </p>
    <button
      type="button"
      aria-label="Close"
      title="Close"
      tabindex={dimmed ? -1 : 0}
      onclick={(event) => {
        event.stopPropagation();
        onDismiss(item.id);
      }}
      class={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition focus-ring",
        HOVER_SURFACE
      )}
    >
      <X class={ICON_SM} aria-hidden="true" />
    </button>
  </div>
  <div
    class={cn(
      "h-0.5 origin-left animate-[toast-progress_3200ms_linear_forwards]",
      style.bar,
      dimmed ? "opacity-0" : "opacity-100"
    )}
  ></div>
</div>
