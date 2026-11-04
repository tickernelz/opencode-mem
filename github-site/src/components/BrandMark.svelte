<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";

  type Props = {
    href?: string;
    label?: string;
    class?: string;
  };

  let { href = "/", label = "opencode-mem", class: className = "" }: Props = $props();
</script>

<a
  class={[
    "inline-flex items-center gap-3 whitespace-nowrap rounded-lg text-foreground-bright no-underline transition-opacity hover:opacity-90",
    className,
  ]
    .filter(Boolean)
    .join(" ")}
  {href}
  aria-label={`${label} home`}
>
  <span
    class="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"
    aria-hidden="true"
  >
    <Brain class="size-4 stroke-current" stroke-width={2} />
  </span>
  <span class="text-xl font-bold leading-none tracking-tight text-foreground-bright">{label}</span>
</a>
