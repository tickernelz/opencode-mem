<script lang="ts">
  import type { SkillDraft } from "$lib/stores/skills.svelte";
  import AppDialog from "$lib/components/ui/app-dialog.svelte";
  import DialogActions from "$lib/components/ui/dialog-actions.svelte";
  import FormField from "$lib/components/ui/form-field.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Checkbox from "$lib/components/ui/checkbox.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { renderMarkdown } from "$lib/markdown";
  import { CARD_PAD, GAP_TIGHT, STACK_FORM, SURFACE_CARD } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    open?: boolean;
    editing?: boolean;
    draft: SkillDraft;
    onOpenChange?: (open: boolean) => void;
    onSave?: () => void;
  };

  let {
    open = $bindable(false),
    editing = false,
    draft = $bindable(),
    onOpenChange,
    onSave,
  }: Props = $props();

  const i18n = useI18n();
  let contentMode = $state<"edit" | "preview">("edit");

  $effect(() => {
    if (open) contentMode = "edit";
  });

  const previewHtml = $derived(renderMarkdown(draft.content || ""));

  function handleOpenChange(next: boolean) {
    open = next;
    onOpenChange?.(next);
  }

  function submit() {
    onSave?.();
  }
</script>

<AppDialog
  bind:open
  title={editing ? i18n.t("modal-skill-edit-title") : i18n.t("modal-skill-create-title")}
  class="sm:max-w-lg"
  onOpenChange={handleOpenChange}
>
  <form
    id="skill-form"
    class={STACK_FORM}
    onsubmit={(e) => {
      e.preventDefault();
      submit();
    }}
  >
    <FormField id="skill-name" label={i18n.t("label-skill-name")} value={draft.name}>
      <Input
        id="skill-name"
        bind:value={draft.name}
        required
        placeholder={i18n.t("placeholder-skill-name")}
      />
    </FormField>

    <FormField
      id="skill-description"
      label={i18n.t("label-skill-description")}
      value={draft.description}
    >
      <Textarea
        id="skill-description"
        rows={4}
        bind:value={draft.description}
        placeholder={i18n.t("placeholder-skill-description")}
      />
    </FormField>

    <div class="space-y-2">
      <div class={cn("flex items-center justify-between", GAP_TIGHT)}>
        <label for="skill-content" class="text-xs font-medium text-foreground">
          {i18n.t("label-skill-content")}
        </label>
        <div class={cn("flex items-center", GAP_TIGHT)}>
          <Button
            type="button"
            variant={contentMode === "edit" ? "secondary" : "ghost"}
            size="xs"
            onclick={() => (contentMode = "edit")}
          >
            {i18n.t("btn-edit")}
          </Button>
          <Button
            type="button"
            variant={contentMode === "preview" ? "secondary" : "ghost"}
            size="xs"
            onclick={() => (contentMode = "preview")}
          >
            {i18n.t("skill-preview")}
          </Button>
        </div>
      </div>

      {#if contentMode === "edit"}
        <Textarea
          id="skill-content"
          rows={10}
          required
          bind:value={draft.content}
          placeholder={i18n.t("placeholder-skill-content")}
        />
      {:else}
        <div
          class={cn(
            SURFACE_CARD,
            CARD_PAD,
            "markdown-content prose-invert max-w-none min-h-48 max-h-80 overflow-y-auto text-sm"
          )}
        >
          {#if draft.content.trim()}
            {@html previewHtml}
          {:else}
            <p class="text-muted-foreground">{i18n.t("placeholder-skill-content")}</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex flex-wrap gap-4">
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={draft.enabled} />
        {i18n.t("label-skill-enabled")}
      </label>
      <label class="flex items-center gap-2 text-sm">
        <Checkbox bind:checked={draft.autoinvoke} />
        {i18n.t("label-skill-autoinvoke")}
      </label>
    </div>
  </form>

  {#snippet footer()}
    <DialogActions
      onCancel={() => handleOpenChange(false)}
      primaryLabel={i18n.t("btn-save")}
      onPrimary={submit}
    />
  {/snippet}
</AppDialog>
