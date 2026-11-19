<script lang="ts">
  import { toast } from "$lib/toast/toast.svelte";
  import { fetchAPI } from "$lib/api";
  import AppDialog from "$lib/components/ui/app-dialog.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import DialogActions from "$lib/components/ui/dialog-actions.svelte";
  import FormField from "$lib/components/ui/form-field.svelte";
  import NativeSelect from "$lib/components/ui/native-select.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { GAP_LOOSE, STACK } from "$lib/ui/styles";

  type Props = {
    open?: boolean;
    count?: number;
    onOpenChange?: (open: boolean) => void;
    onComplete?: () => void;
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

  let { open = $bindable(false), count = 0, onOpenChange, onComplete }: Props = $props();

  const i18n = useI18n();
  let running = $state(false);
  let status = $state("");
  let progress = $state(0);

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
    if (open && !running) {
      status = i18n.t("migration-found-tags", { count });
      progress = 0;
      void loadCatalog();
    }
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
      return;
    }
    catalog = result.data;
    const data = result.data;
    const provider = data.providers.find((entry) => entry.id === data.providerID);
    if (provider) {
      selectedProvider = provider.id;
      selectedModel = provider.models.some((model) => model.id === data.modelID)
        ? (data.modelID ?? "")
        : "";
    }
  }

  function handleOpenChange(next: boolean) {
    if (running && !next) return;
    open = next;
    onOpenChange?.(next);
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
    } else {
      toast.error(i18n.t("toast-model-save-failed"));
    }
  }

  async function runTagMigration() {
    running = true;
    status = i18n.t("status-migration-init");
    progress = 0;

    let hasMore = true;
    let attempts = 0;
    let totalErrors = 0;
    let totalItems = 0;
    let totalProcessed = 0;
    const maxAttempts = 1000;

    while (hasMore && attempts < maxAttempts) {
      attempts++;
      const result = await fetchAPI<{
        processed: number;
        hasMore: boolean;
        total: number;
        errors?: number;
      }>("/api/migration/tags/run-batch", {
        method: "POST",
        body: JSON.stringify({ batchSize: 3 }),
      });

      if (!result.success || !result.data) {
        const failedMsg =
          i18n.t("toast-migration-failed") + (result.error ? `: ${result.error}` : "");
        status = failedMsg;
        toast.error(failedMsg);
        running = false;
        return;
      }

      totalProcessed = result.data.processed;
      hasMore = result.data.hasMore;
      totalItems = result.data.total;
      totalErrors = result.data.errors ?? 0;
      progress = totalItems > 0 ? Math.round((totalProcessed / totalItems) * 100) : 0;
      status = i18n.t("status-migration-progress", {
        current: totalProcessed,
        total: totalItems,
      });
      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (attempts >= maxAttempts) {
      status = i18n.t("migration-stopped");
      running = false;
      return;
    }

    if (totalErrors > 0) {
      const finalProgress = totalItems > 0 ? Math.round((totalProcessed / totalItems) * 100) : 0;
      progress = finalProgress;
      const failedMsg = i18n.t("toast-migration-tag-failures", { count: totalErrors });
      status = failedMsg;
      toast.error(failedMsg);
      running = false;
      return;
    }

    progress = 100;
    status = i18n.t("toast-migration-success");
    toast.success(i18n.t("toast-migration-success"));
    setTimeout(() => {
      running = false;
      handleOpenChange(false);
      onComplete?.();
    }, 2000);
  }
</script>

<AppDialog
  bind:open
  title={i18n.t("modal-migration-title")}
  class="sm:max-w-md"
  showCloseButton={!running}
  onOpenChange={handleOpenChange}
>
  <div class={STACK}>
    <p class="text-sm text-muted-foreground">{status}</p>
    <div class="h-2 rounded-full bg-muted overflow-hidden">
      <div
        class="h-full bg-primary transition-all duration-200"
        style={`width: ${progress}%`}
      ></div>
    </div>

    {#if catalog?.available}
      <div class="grid sm:grid-cols-2 {GAP_LOOSE}">
        <FormField
          id="migration-model-provider"
          label={i18n.t("label-model-provider")}
          value={selectedProvider}
        >
          <NativeSelect
            id="migration-model-provider"
            bind:value={selectedProvider}
            disabled={running || savingModel}
            onchange={() => (selectedModel = "")}
          >
            <option value=""></option>
            {#each catalog.providers as provider (provider.id)}
              <option value={provider.id} disabled={!provider.connected}>{provider.name}</option>
            {/each}
          </NativeSelect>
        </FormField>
        <FormField
          id="migration-model-name"
          label={i18n.t("label-model-name")}
          value={selectedModel}
        >
          <NativeSelect
            id="migration-model-name"
            bind:value={selectedModel}
            disabled={running || savingModel || modelOptions.length === 0}
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
          disabled={!selectedProvider || !selectedModel || !selectionDirty || savingModel}
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

    <p class="text-xs text-muted-foreground">{i18n.t("migration-note")}</p>
  </div>
  {#snippet footer()}
    {#if !running}
      <DialogActions
        onCancel={() => handleOpenChange(false)}
        primaryLabel={i18n.t("btn-start-migration")}
        primaryDisabled={!catalog?.configured}
        onPrimary={() => void runTagMigration()}
      />
    {/if}
  {/snippet}
</AppDialog>
