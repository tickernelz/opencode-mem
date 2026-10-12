<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { STACK_DENSE, STACK_TIGHT } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    id?: string;
    label: string;
    class?: string;
    labelClass?: string;
    /** When false, label sits above the control (composite / non-text fields). */
    floating?: boolean;
    /**
     * Current value — pass for selects / whenever CSS `:placeholder-shown` is not enough.
     * Omit for text inputs/textareas that use an empty `placeholder`.
     */
    value?: string | null;
    spacing?: "tight" | "normal";
    srOnly?: boolean;
    children?: Snippet;
  } & Omit<HTMLAttributes<HTMLDivElement>, "class" | "children">;

  let {
    id,
    label,
    class: className,
    labelClass,
    floating = true,
    value,
    spacing = "tight",
    srOnly = false,
    children,
    ...rest
  }: Props = $props();

  let focused = $state(false);
  const controlled = $derived(value !== undefined);
  const floated = $derived(focused || (value != null && String(value).length > 0));
</script>

{#if srOnly || !floating}
  <div class={cn(spacing === "tight" ? STACK_DENSE : STACK_TIGHT, className)} {...rest}>
    <label
      for={id}
      class={cn(
        "flex items-center gap-2 text-xs font-medium leading-none select-none text-foreground",
        srOnly && "sr-only",
        labelClass
      )}
    >
      {label}
    </label>
    {@render children?.()}
  </div>
{:else}
  <div
    class={cn("group/field relative", className)}
    {...rest}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    {@render children?.()}
    <label
      for={id}
      class={cn(
        "pointer-events-none absolute inset-s-2.5 z-10 max-w-[calc(100%-1.25rem)] truncate rounded-none leading-none transition-[top,transform,font-size,color,background-color,padding] duration-150",
        controlled
          ? floated
            ? "top-0 -translate-y-1/2 bg-(--floating-label-bg,var(--card)) px-1 text-xs font-medium text-foreground-bright"
            : "top-1/2 -translate-y-1/2 bg-transparent px-0 text-sm font-normal text-muted-foreground"
          : [
              "top-0 -translate-y-1/2 bg-(--floating-label-bg,var(--card)) px-1 text-xs font-medium text-foreground-bright",
              "group-has-[input:placeholder-shown:not(:focus)]/field:top-1/2",
              "group-has-[input:placeholder-shown:not(:focus)]/field:bg-transparent",
              "group-has-[input:placeholder-shown:not(:focus)]/field:px-0",
              "group-has-[input:placeholder-shown:not(:focus)]/field:text-sm",
              "group-has-[input:placeholder-shown:not(:focus)]/field:font-normal",
              "group-has-[input:placeholder-shown:not(:focus)]/field:text-muted-foreground",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:top-3",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:translate-y-0",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:bg-transparent",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:px-0",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:text-sm",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:font-normal",
              "group-has-[textarea:placeholder-shown:not(:focus)]/field:text-muted-foreground",
            ],
        labelClass
      )}
    >
      {label}
    </label>
  </div>
{/if}
