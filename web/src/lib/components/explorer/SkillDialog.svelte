<script lang="ts">
  import type { SkillDraft } from "$lib/stores/skills.svelte";
  import AppDialog from "$lib/components/ui/app-dialog.svelte";
  import DialogActions from "$lib/components/ui/dialog-actions.svelte";
  import FormField from "$lib/components/ui/form-field.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Checkbox from "$lib/components/ui/checkbox.svelte";
  import MarkdownEditor from "$lib/components/ui/markdown-editor.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { STACK_FORM } from "$lib/ui/styles";

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
  class="max-w-4xl sm:max-w-4xl"
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
    <div class="grid gap-3 md:grid-cols-2">
      <FormField id="skill-id" label={i18n.t("label-skill-id")} value={draft.id}>
        <Input
          id="skill-id"
          bind:value={draft.id}
          disabled={editing}
          required={!editing}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxlength={64}
          placeholder={i18n.t("placeholder-skill-id")}
        />
        <p class="mt-1 text-xs text-muted-foreground">{i18n.t("hint-skill-id")}</p>
      </FormField>
      <FormField id="skill-name" label={i18n.t("label-skill-name")} value={draft.name}>
        <Input
          id="skill-name"
          bind:value={draft.name}
          required
          placeholder={i18n.t("placeholder-skill-name")}
        />
      </FormField>
    </div>

    <FormField
      id="skill-description"
      label={i18n.t("label-skill-description")}
      value={draft.description}
    >
      <Input
        id="skill-description"
        bind:value={draft.description}
        placeholder={i18n.t("placeholder-skill-description")}
      />
    </FormField>

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

    <FormField label={i18n.t("label-skill-content")} floating={false} spacing="normal">
      <MarkdownEditor
        bind:value={draft.content}
        placeholder={i18n.t("placeholder-skill-content")}
        editLabel={i18n.t("skill-edit")}
        previewLabel={i18n.t("skill-preview")}
        minHeight="18rem"
      />
    </FormField>
  </form>

  {#snippet footer()}
    <DialogActions
      onCancel={() => handleOpenChange(false)}
      primaryLabel={i18n.t("btn-save")}
      onPrimary={submit}
    />
  {/snippet}
</AppDialog>
