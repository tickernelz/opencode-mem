<script lang="ts">
  import type { SkillDraft } from "$lib/stores/skills.svelte";
  import AppDialog from "$lib/components/ui/app-dialog.svelte";
  import DialogActions from "$lib/components/ui/dialog-actions.svelte";
  import FormField from "$lib/components/ui/form-field.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Checkbox from "$lib/components/ui/checkbox.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { GAP_LOOSE, STACK_FORM } from "$lib/ui/styles";

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
    <div class="grid sm:grid-cols-2 {GAP_LOOSE}">
      <FormField id="skill-id" label={i18n.t("label-skill-id")} value={draft.id}>
        <Input
          id="skill-id"
          bind:value={draft.id}
          disabled={editing}
          required={!editing}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          maxlength={64}
        />
      </FormField>
      <FormField id="skill-name" label={i18n.t("label-skill-name")} value={draft.name}>
        <Input id="skill-name" bind:value={draft.name} required />
      </FormField>
    </div>

    <p class="text-xs text-muted-foreground">{i18n.t("hint-skill-id")}</p>

    <FormField
      id="skill-description"
      label={i18n.t("label-skill-description")}
      value={draft.description}
    >
      <Input id="skill-description" bind:value={draft.description} />
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

    <FormField id="skill-content" label={i18n.t("label-skill-content")} value={draft.content}>
      <Textarea id="skill-content" rows={10} required bind:value={draft.content} />
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
