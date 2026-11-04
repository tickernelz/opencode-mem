<script lang="ts">
  import type { Snippet } from "svelte";
  import GithubSlugger from "github-slugger";
  import Moon from "@lucide/svelte/icons/moon";
  import Sun from "@lucide/svelte/icons/sun";
  import Languages from "@lucide/svelte/icons/languages";
  import Menu from "@lucide/svelte/icons/menu";
  import X from "@lucide/svelte/icons/x";
  import BrandMark from "../BrandMark.svelte";
  import GithubIcon from "../GithubIcon.svelte";
  import DocsSearch from "./DocsSearch.svelte";
  import { docsHref, LOCALES, type DocsLocale } from "../../lib/docs-shared";

  type NavItem = { title: string; href: string; slug: string };
  type NavGroup = { label: string; items: NavItem[] };

  type Props = {
    lang: string;
    currentSlug: string;
    title: string;
    groups: NavGroup[];
    children?: Snippet;
  };

  let { lang, currentSlug, title, groups, children }: Props = $props();

  let navOpen = $state(false);

  const localeOrder = $derived([
    { code: "en" as DocsLocale, href: docsHref("", currentSlug), label: "English" },
    ...LOCALES.map((code) => ({
      code: code as DocsLocale,
      href: docsHref(code, currentSlug),
      label: (
        {
          de: "Deutsch",
          zh: "简体中文",
          ar: "العربية",
          tr: "Türkçe",
          nl: "Nederlands",
        } as const
      )[code],
    })),
  ]);

  const currentLocale = $derived((lang === "" ? "en" : lang) as DocsLocale);
  const currentLocaleMeta = $derived(
    localeOrder.find((item) => item.code === currentLocale) ?? localeOrder[0]
  );
  const nextLocale = $derived(
    localeOrder[
      (localeOrder.findIndex((item) => item.code === currentLocale) + 1) % localeOrder.length
    ]
  );

  const titleSlug = $derived(new GithubSlugger().slug(title));

  const flat = $derived(groups.flatMap((group) => group.items));
  const index = $derived(flat.findIndex((item) => item.slug === currentSlug));
  const prev = $derived(index > 0 ? flat[index - 1] : undefined);
  const next = $derived(index >= 0 && index < flat.length - 1 ? flat[index + 1] : undefined);

  function toggleTheme() {
    const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    document.documentElement.style.backgroundColor = nextTheme === "light" ? "#f5f4f8" : "#0a0a0a";
    localStorage.setItem("om-theme", nextTheme);
  }

  function cycleLocale() {
    if (!nextLocale) return;
    window.location.assign(nextLocale.href);
  }

  function closeNav() {
    navOpen = false;
  }
</script>

<div class="docs min-h-screen text-[0.9375rem] leading-relaxed">
  <!-- Fixed corner controls (no top bar) -->
  <div class="docs__corner">
    <a
      class="theme-toggle"
      href="https://github.com/tickernelz/opencode-mem"
      aria-label="GitHub"
      title="GitHub"
    >
      <GithubIcon />
    </a>
    <button
      class="theme-toggle"
      type="button"
      aria-label={`Language: ${currentLocaleMeta?.label}. Switch to ${nextLocale?.label}`}
      title={`${currentLocaleMeta?.label} → ${nextLocale?.label}`}
      onclick={cycleLocale}
    >
      <Languages aria-hidden="true" />
    </button>
    <button
      class="theme-toggle"
      type="button"
      aria-label="Switch color theme"
      title="Switch color theme"
      onclick={toggleTheme}
    >
      <Moon class="docs-theme-icon docs-theme-icon--dark" aria-hidden="true" />
      <Sun class="docs-theme-icon docs-theme-icon--light" aria-hidden="true" />
    </button>
  </div>

  <button
    class="docs__menu theme-toggle"
    type="button"
    aria-label={navOpen ? "Close navigation" : "Open navigation"}
    aria-expanded={navOpen}
    aria-controls="docs-sidebar"
    onclick={() => (navOpen = !navOpen)}
  >
    {#if navOpen}
      <X aria-hidden="true" />
    {:else}
      <Menu aria-hidden="true" />
    {/if}
  </button>

  {#if navOpen}
    <button
      class="fixed inset-0 z-[35] cursor-pointer border-0 bg-black/45 md:hidden"
      type="button"
      aria-label="Close navigation"
      onclick={closeNav}
    ></button>
  {/if}

  <aside
    id="docs-sidebar"
    class={[
      "docs__sidebar fixed inset-y-0 left-0 z-[36] flex w-[min(18rem,88vw)] flex-col border-r md:z-30 md:w-sidebar",
      "max-md:transition-transform max-md:duration-200",
      navOpen
        ? "max-md:translate-x-0 max-md:shadow-[12px_0_40px_color-mix(in_srgb,black_35%,transparent)]"
        : "max-md:-translate-x-full",
    ].join(" ")}
  >
    <div class="flex flex-col gap-3 px-3 pt-4 pb-2">
      <BrandMark />
      <DocsSearch {lang} variant="sidebar" />
    </div>

    <nav class="min-h-0 flex-1 overflow-auto overscroll-contain px-3 pt-1 pb-6" aria-label="Docs">
      {#each groups as group}
        <div class="mb-5">
          <p class="mb-1.5 px-2 text-[0.7rem] font-medium text-muted-foreground">
            {group.label}
          </p>
          <ul class="m-0 grid list-none gap-0.5 p-0">
            {#each group.items as item}
              <li>
                <a
                  class={[
                    "block rounded-lg px-2 py-1.5 text-sm font-medium leading-snug no-underline transition-colors",
                    item.slug === currentSlug
                      ? "bg-primary/12 font-semibold text-primary"
                      : "text-foreground/90 hover:bg-surface-hover hover:text-foreground-bright",
                  ].join(" ")}
                  href={item.href}
                  aria-current={item.slug === currentSlug ? "page" : undefined}
                  onclick={closeNav}
                >
                  {item.title}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>

    <div class="border-t border-border/60 px-3 py-3">
      <a
        class="block rounded-lg px-2 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-surface-hover hover:text-foreground-bright"
        href="/"
      >
        ← Home
      </a>
    </div>
  </aside>

  <main
    class="docs__main min-h-screen min-w-0 px-6 pt-8 pb-14 pe-[max(var(--docs-edge),4.5rem)] md:ms-sidebar md:px-8 max-md:px-[var(--docs-edge)] max-md:pt-16"
    id="docs-content"
  >
    <article class="docs__article mx-auto max-w-3xl">
      <h1 id={titleSlug}>{title}</h1>
      {#if children}
        {@render children()}
      {/if}
    </article>

    {#if prev || next}
      <nav
        class="mx-auto mt-11 grid max-w-3xl grid-cols-1 gap-3 border-t border-border pt-6 sm:grid-cols-2"
        aria-label="Page"
      >
        {#if prev}
          <a
            class="docs__pager-link grid gap-1 rounded-xl border px-4 py-3.5 text-inherit no-underline transition-colors hover:border-primary/40"
            href={prev.href}
          >
            <span class="text-xs font-medium text-muted-foreground">Previous</span>
            <span class="font-semibold leading-snug text-foreground-bright">{prev.title}</span>
          </a>
        {:else}
          <span></span>
        {/if}
        {#if next}
          <a
            class="docs__pager-link grid gap-1 justify-self-stretch rounded-xl border px-4 py-3.5 text-start text-inherit no-underline transition-colors hover:border-primary/40 sm:justify-self-end sm:text-end"
            href={next.href}
          >
            <span class="text-xs font-medium text-muted-foreground">Next</span>
            <span class="font-semibold leading-snug text-foreground-bright">{next.title}</span>
          </a>
        {/if}
      </nav>
    {/if}
  </main>
</div>
