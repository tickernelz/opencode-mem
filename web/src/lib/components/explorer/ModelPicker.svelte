<script lang="ts">
  import { toast } from "$lib/toast/toast.svelte";
  import { fetchAPI } from "$lib/api";
  import Button from "$lib/components/ui/button.svelte";
  import FormField from "$lib/components/ui/form-field.svelte";
  import NativeSelect from "$lib/components/ui/native-select.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { GAP_LOOSE, STACK } from "$lib/ui/styles";

  type Props = {
    idPrefix?: string;
    disabled?: boolean;
    configured?: boolean;
    onSaved?: () => void;
  };

  type ModelCatalog = {
    available: boolean;
    reason?: string;
    configured: boolean;
    providerID: string | null;
    modelID: string | null;
    providers: Array<{
      id: string;
      name: string;
      connected: boolean;
      models: Array<{ id: string; name: string }>;
    }>;
  };

  let {
    idPrefix = "model",
    disabled = false,
    configured = $bindable(false),
    onSaved,
  }: Props = $props();

  const i18n = useI18n();
  let catalog = $state<ModelCatalog | null>(null);
  let selectedProvider = $state("");
  let selectedModel = $state("");
  let savingModel = $state(false);

  const modelOptions = $derived(
    catalog?.providers.find((provider) => provider.id === selectedProvider)?.models ?? []
  );
  const selectionDirty = $derived(
    selectedProvider !== (catalog?.providerID ?? "") || selectedModel !== (catalog?.modelID ?? "")
  );

  $effect(() => {
    void loadCatalog();
  });

  async function loadCatalog() {
    const result = await fetchAPI<ModelCatalog>("/api/config/model-provider");
    if (!result.success || !result.data) {
      catalog = {
        available: false,
        reason: result.error ?? "",
        configured: false,
        providerID: null,
        modelID: null,
        providers: [],
      };
      configured = false;
      return;
    }
    catalog = result.data;
    configured = result.data.configured;
    const data = result.data;
    const provider = data.providers.find((entry) => entry.id === data.providerID);
    if (provider) {
      selectedProvider = provider.id;
      selectedModel = provider.models.some((model) => model.id === data.modelID)
        ? (data.modelID ?? "")
        : "";
    }
  }

  async function saveModel() {
    savingModel = true;
    const result = await fetchAPI<{ writtenTo: string; requiresReload: boolean }>(
      "/api/config/model-provider",
      {
        method: "PUT",
        body: JSON.stringify({ providerID: selectedProvider, modelID: selectedModel }),
      }
    );
    savingModel = false;

    if (!result.success || !result.data) {
      toast.error(result.error ?? i18n.t("toast-model-save-failed"));
      return;
    }
    // Re-read instead of trusting the response: a project config file may still
    // override the value we just wrote.
    await loadCatalog();
    if (catalog?.configured) {
      toast.success(i18n.t("toast-model-saved"));
      onSaved?.();
    } else {
      toast.error(i18n.t("toast-model-save-failed"));
    }
  }
</script>

<div class={STACK}>
  {#if catalog?.available}
    <div class="grid sm:grid-cols-2 {GAP_LOOSE}">
      <FormField
        id="{idPrefix}-provider"
        label={i18n.t("label-model-provider")}
        value={selectedProvider}
      >
        <NativeSelect
          id="{idPrefix}-provider"
          bind:value={selectedProvider}
          disabled={disabled || savingModel}
          onchange={() => (selectedModel = "")}
        >
          <option value=""></option>
          {#each catalog.providers as provider (provider.id)}
            <option value={provider.id} disabled={!provider.connected}>{provider.name}</option>
          {/each}
        </NativeSelect>
      </FormField>
      <FormField id="{idPrefix}-name" label={i18n.t("label-model-name")} value={selectedModel}>
        <NativeSelect
          id="{idPrefix}-name"
          bind:value={selectedModel}
          disabled={disabled || savingModel || modelOptions.length === 0}
        >
          <option value=""></option>
          {#each modelOptions as model (model.id)}
            <option value={model.id}>{model.name}</option>
          {/each}
        </NativeSelect>
      </FormField>
    </div>
    <div class="flex justify-end">
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || !selectedProvider || !selectedModel || !selectionDirty || savingModel}
        onclick={() => void saveModel()}
      >
        {i18n.t("btn-save")}
      </Button>
    </div>
  {:else if catalog}
    <p class="text-xs text-muted-foreground">
      {i18n.t("migration-model-unavailable", { reason: catalog.reason ?? "" })}
    </p>
  {/if}

  {#if catalog && !catalog.configured}
    <p class="text-xs text-muted-foreground">{i18n.t("migration-model-required")}</p>
  {/if}
</div>
