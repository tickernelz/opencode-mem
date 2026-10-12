<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import MinusIcon from "@lucide/svelte/icons/minus";
  import { Checkbox as CheckboxPrimitive } from "bits-ui";
  import { ICON_SM } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = CheckboxPrimitive.RootProps & { class?: string };

  let {
    class: className,
    checked = $bindable(false),
    indeterminate = $bindable(false),
    ...rest
  }: Props = $props();
</script>

<CheckboxPrimitive.Root
  data-slot="checkbox"
  bind:checked
  bind:indeterminate
  class={cn(
    "border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground dark:data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive peer relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-lg border shadow-xs transition-shadow outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
    className
  )}
  {...rest}
>
  {#snippet children({ checked: isChecked, indeterminate: isIndeterminate })}
    <div
      data-slot="checkbox-indicator"
      class="pointer-events-none grid place-content-center text-current [&>svg]:size-3.5"
    >
      {#if isIndeterminate}
        <MinusIcon class={ICON_SM} />
      {:else if isChecked}
        <CheckIcon class={ICON_SM} />
      {/if}
    </div>
  {/snippet}
</CheckboxPrimitive.Root>
