<script lang="ts">
  import { onMount, tick } from "svelte";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import entries from "../../data/docs-search.json";

  type SearchHit = {
    title: string;
    href: string;
    lang: string;
    description: string;
    text: string;
  };

  type Props = {
    lang: string;
    /** Fumadocs-style full trigger in the sidebar, or compact icon for mobile header */
    variant?: "sidebar" | "icon";
  };
  let { lang, variant = "sidebar" }: Props = $props();

  /** Only the sidebar instance owns the dialog + ⌘K listener */
  const ownsDialog = variant === "sidebar";

  let open = $state(false);
  let query = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);
  let active = $state(0);

  const locale = $derived(lang === "" ? "en" : lang);
  const corpus = $derived((entries as SearchHit[]).filter((entry) => entry.lang === locale));

  const hits = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return corpus.slice(0, 8);
    const terms = q.split(/\s+/).filter(Boolean);
    return corpus
      .map((entry) => {
        const hay = `${entry.title} ${entry.description} ${entry.text}`.toLowerCase();
        const score = terms.reduce((sum, term) => {
          if (entry.title.toLowerCase().includes(term)) return sum + 8;
          if (entry.description.toLowerCase().includes(term)) return sum + 3;
          if (hay.includes(term)) return sum + 1;
          return sum - 20;
        }, 0);
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((item) => item.entry);
  });

  $effect(() => {
    query;
    active = 0;
  });

  $effect(() => {
    if (!ownsDialog) return;
    if (!open) {
      document.documentElement.style.overflow = "";
      query = "";
      return;
    }
    document.documentElement.style.overflow = "hidden";
    tick().then(() => {
      inputEl?.focus();
    });
  });

  onMount(() => {
    if (!ownsDialog) return;

    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open = !open;
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        open = false;
      }
    }

    function onOpenRequest() {
      open = true;
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("docs-search-open", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("docs-search-open", onOpenRequest);
      document.documentElement.style.overflow = "";
    };
  });

  function requestOpen() {
    if (ownsDialog) {
      open = true;
      return;
    }
    window.dispatchEvent(new Event("docs-search-open"));
  }

  function go(href: string) {
    open = false;
    window.location.assign(href);
  }

  function onInputKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(active + 1, Math.max(hits.length - 1, 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (event.key === "Enter") {
      const hit = hits[active];
      if (!hit) return;
      event.preventDefault();
      go(hit.href);
    }
  }
</script>

{#if variant === "icon"}
  <button
    class="theme-toggle md:hidden"
    type="button"
    aria-label="Search docs"
    title="Search (⌘K)"
    onclick={requestOpen}
  >
    <Search aria-hidden="true" />
  </button>
{:else}
  <button
    class="docs__search-trigger inline-flex h-10 w-full items-center gap-3 rounded-xl border ps-[calc(0.625rem-1px)] pe-2 text-sm text-muted-foreground transition-colors hover:text-foreground-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    type="button"
    aria-label="Search docs"
    title="Search (⌘K)"
    onclick={requestOpen}
  >
    <Search class="size-4 shrink-0 stroke-current" stroke-width={2} aria-hidden="true" />
    <span class="flex-1 text-start font-medium">Search</span>
    <span class="ms-auto inline-flex gap-0.5" aria-hidden="true">
      <kbd
        class="rounded-md border border-border/50 bg-background px-1.5 font-sans text-[0.7rem] text-muted-foreground"
        >⌘</kbd
      >
      <kbd
        class="rounded-md border border-border/50 bg-background px-1.5 font-sans text-[0.7rem] text-muted-foreground"
        >K</kbd
      >
    </span>
  </button>
{/if}

{#if ownsDialog && open}
  <div
    class="fixed inset-0 z-[60] grid place-items-start justify-center px-4 pt-[min(20vh,8rem)] pb-8"
    role="dialog"
    aria-modal="true"
    aria-label="Search docs"
  >
    <button
      class="absolute inset-0 cursor-pointer border-0 bg-black/55"
      type="button"
      aria-label="Close search"
      onclick={() => (open = false)}
    ></button>
    <div
      class="relative z-[1] flex max-h-[min(70vh,32rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-[0_24px_64px_color-mix(in_srgb,black_45%,transparent)]"
    >
      <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Search
          class="size-4 shrink-0 stroke-current text-muted-foreground"
          stroke-width={2}
          aria-hidden="true"
        />
        <input
          bind:this={inputEl}
          class="min-w-0 flex-1 border-0 bg-transparent text-[0.95rem] text-foreground-bright outline-none placeholder:text-muted-foreground"
          type="search"
          placeholder="Search docs…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          bind:value={query}
          onkeydown={onInputKey}
        />
        <kbd
          class="hidden rounded-md border border-border/50 bg-background px-1.5 font-sans text-[0.7rem] text-muted-foreground sm:inline-block"
          >Esc</kbd
        >
        <button
          class="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:hidden"
          type="button"
          aria-label="Close"
          onclick={() => (open = false)}
        >
          <X class="size-4 stroke-current" stroke-width={2} aria-hidden="true" />
        </button>
      </div>
      <ul class="m-0 list-none overflow-auto p-1.5" role="listbox">
        {#if hits.length === 0}
          <li class="px-3 py-4 text-sm text-muted-foreground">No results</li>
        {:else}
          {#each hits as hit, i}
            <li>
              <a
                class={[
                  "grid gap-0.5 rounded-lg px-3 py-2.5 text-inherit no-underline transition-colors",
                  i === active ? "bg-primary/14" : "hover:bg-primary/10",
                ].join(" ")}
                href={hit.href}
                role="option"
                aria-selected={i === active}
                onmouseenter={() => (active = i)}
                onclick={(event) => {
                  event.preventDefault();
                  go(hit.href);
                }}
              >
                <span class="text-[0.9rem] font-semibold text-foreground-bright">{hit.title}</span>
                {#if hit.description}
                  <span class="line-clamp-2 text-[0.78rem] leading-snug text-muted-foreground"
                    >{hit.description}</span
                  >
                {/if}
              </a>
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  </div>
{/if}
