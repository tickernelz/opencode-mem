<script lang="ts">
  import { toast } from "$lib/toast/toast.svelte";
  import { fetchAPI } from "$lib/api";
  import AppDialog from "$lib/components/ui/app-dialog.svelte";
  import DialogActions from "$lib/components/ui/dialog-actions.svelte";
  import ModelPicker from "$lib/components/explorer/ModelPicker.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { STACK } from "$lib/ui/styles";

  type Props = {
    open?: boolean;
    count?: number;
    onOpenChange?: (open: boolean) => void;
    onComplete?: () => void;
  };

  let { open = $bindable(false), count = 0, onOpenChange, onComplete }: Props = $props();

  const i18n = useI18n();
  let running = $state(false);
  let status = $state("");
  let progress = $state(0);
  let readyForMigration = $state(false);

  $effect(() => {
    if (open && !running) {
      status = i18n.t("migration-found-tags", { count });
      progress = 0;
    }
  });

  function handleOpenChange(next: boolean) {
    if (running && !next) return;
    open = next;
    onOpenChange?.(next);
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

    <ModelPicker idPrefix="migration-model" disabled={running} bind:readyForMigration />

    <p class="text-xs text-muted-foreground">{i18n.t("migration-note")}</p>
  </div>
  {#snippet footer()}
    {#if !running}
      <DialogActions
        onCancel={() => handleOpenChange(false)}
        primaryLabel={i18n.t("btn-start-migration")}
        primaryDisabled={!readyForMigration}
        onPrimary={() => void runTagMigration()}
      />
    {/if}
  {/snippet}
</AppDialog>
