<script lang="ts">
  import BorderedPanel from "$lib/components/ui/bordered-panel.svelte";
  import ModelPicker from "$lib/components/explorer/ModelPicker.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { STACK_SECTION } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  const i18n = useI18n();
</script>

<div class={cn(STACK_SECTION, "max-w-2xl")}>
  <BorderedPanel title={i18n.t("label-model-name")}>
    <ModelPicker idPrefix="settings-model" />
    <p class="text-xs text-muted-foreground">{i18n.t("model-settings-note")}</p>
  </BorderedPanel>
</div>
