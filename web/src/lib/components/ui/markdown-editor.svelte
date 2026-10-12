<script lang="ts">
  import CodeMirror from "svelte-codemirror-editor";
  import { markdown } from "@codemirror/lang-markdown";
  import { oneDark } from "@codemirror/theme-one-dark";
  import { EditorView } from "@codemirror/view";
  import Button from "$lib/components/ui/button.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import { createTheme } from "$lib/theme.svelte";
  import { cn } from "$lib/utils";

  type Props = {
    value?: string;
    placeholder?: string;
    editLabel?: string;
    previewLabel?: string;
    class?: string;
    minHeight?: string;
  };

  let {
    value = $bindable(""),
    placeholder = "",
    editLabel = "Edit",
    previewLabel = "Preview",
    class: className,
    minHeight = "16rem",
  }: Props = $props();

  const themeStore = createTheme();
  const isDark = $derived(themeStore.theme === "dark");
  let mobileTab = $state<"edit" | "preview">("edit");

  const previewHtml = $derived(renderMarkdown(value || ""));
</script>

<div class={cn("space-y-2", className)}>
  <div class="flex gap-1 md:hidden">
    <Button
      type="button"
      size="xs"
      variant={mobileTab === "edit" ? "secondary" : "ghost"}
      onclick={() => (mobileTab = "edit")}
    >
      {editLabel}
    </Button>
    <Button
      type="button"
      size="xs"
      variant={mobileTab === "preview" ? "secondary" : "ghost"}
      onclick={() => (mobileTab = "preview")}
    >
      {previewLabel}
    </Button>
  </div>

  <div class="grid gap-3 md:grid-cols-2" style:min-height={minHeight}>
    <div
      class={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        mobileTab !== "edit" && "max-md:hidden"
      )}
    >
      <CodeMirror
        bind:value
        lang={markdown()}
        theme={isDark ? oneDark : undefined}
        extensions={[EditorView.lineWrapping]}
        styles={{
          "&": {
            height: minHeight,
            fontSize: "0.875rem",
          },
        }}
        {placeholder}
        class="text-sm [&_.cm-editor]:outline-none [&_.cm-scroller]:font-mono"
      />
    </div>
    <div
      class={cn(
        "overflow-auto rounded-xl border border-border bg-muted/30 p-3",
        mobileTab !== "preview" && "max-md:hidden"
      )}
      style:min-height={minHeight}
    >
      {#if value.trim()}
        <div class="markdown-content prose-invert max-w-none text-sm">
          {@html previewHtml}
        </div>
      {:else}
        <p class="text-sm text-muted-foreground">{placeholder}</p>
      {/if}
    </div>
  </div>
</div>
