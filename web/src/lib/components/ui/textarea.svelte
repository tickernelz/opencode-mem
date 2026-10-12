<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$lib/utils";

  type Props = HTMLTextareaAttributes & { class?: string };

  let { class: className, value = $bindable(), placeholder = " ", ...rest }: Props = $props();
</script>

<!--
  Border + radius live on a clipping wrapper so native resize/scrollbars
  cannot square off corners (Chrome/WebKit).
-->
<div
  data-slot="textarea"
  class={cn(
    "border-input flex w-full overflow-hidden rounded-xl border bg-card shadow-xs transition-[color,box-shadow]",
    "focus-within:border-primary",
    "has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40",
    "has-disabled:opacity-50",
    className
  )}
>
  <textarea
    class="field-sizing-content min-h-20 w-full resize-y border-0 bg-transparent px-2.5 py-2.5 text-sm outline-none placeholder:text-transparent disabled:cursor-not-allowed"
    {placeholder}
    bind:value
    {...rest}></textarea>
</div>
