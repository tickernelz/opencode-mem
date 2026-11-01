<script lang="ts">
  import Button from "$lib/components/ui/button.svelte";
  import { useI18n } from "$lib/i18n/context.svelte";
  import { GAP, STACK } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  export type TrashItem = {
    id: string;
    content: string;
    deletedAt: number;
    mergedInto?: string;
    supersededBy?: string;
    projectName?: string;
    containerTag: string;
  };

  let {
    open = $bindable(false),
    items = [],
    loading = false,
    onRestore,
    onClose,
  }: {
    open?: boolean;
    items?: TrashItem[];
    loading?: boolean;
    onRestore: (id: string) => void | Promise<void>;
    onClose?: () => void;
  } = $props();

  const i18n = useI18n();

  function close() {
    open = false;
    onClose?.();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="trash-dialog-title"
  >
    <div
      class={cn(
        "bg-background flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border shadow-lg",
        STACK
      )}
    >
      <div class={cn("flex shrink-0 items-center justify-between border-b px-4 py-3", GAP)}>
        <h2 id="trash-dialog-title" class="text-lg font-semibold">{i18n.t("modal-trash-title")}</h2>
        <Button type="button" variant="outline" onclick={close}>{i18n.t("btn-cancel")}</Button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {#if loading}
          <p class="text-muted-foreground text-sm">{i18n.t("loading-trash")}</p>
        {:else if items.length === 0}
          <p class="text-muted-foreground text-sm">{i18n.t("empty-trash")}</p>
        {:else}
          <ul class={STACK}>
            {#each items as item (item.id)}
              <li class="rounded border p-3">
                <p class="line-clamp-3 text-sm whitespace-pre-wrap">{item.content}</p>
                <div
                  class={cn("text-muted-foreground mt-2 flex flex-wrap items-center text-xs", GAP)}
                >
                  <span>{new Date(item.deletedAt).toLocaleString()}</span>
                  {#if item.projectName}
                    <span>{item.projectName}</span>
                  {/if}
                  {#if item.mergedInto}
                    <span>{i18n.t("trash-merged-into", { id: item.mergedInto })}</span>
                  {/if}
                  {#if item.supersededBy}
                    <span>{i18n.t("trash-superseded-by", { id: item.supersededBy })}</span>
                  {/if}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onclick={() => onRestore(item.id)}
                  >
                    {i18n.t("btn-restore")}
                  </Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}
