<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import Folder from "@lucide/svelte/icons/folder";
  import Languages from "@lucide/svelte/icons/languages";
  import Moon from "@lucide/svelte/icons/moon";
  import ScrollText from "@lucide/svelte/icons/scroll-text";
  import Sun from "@lucide/svelte/icons/sun";
  import User from "@lucide/svelte/icons/user";
  import X from "@lucide/svelte/icons/x";
  import GithubIcon from "$lib/components/icons/GithubIcon.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import { navigate, ROUTES, shouldHandleSpaClick, type AppView } from "$lib/router";
  import { createTheme } from "$lib/theme.svelte";
  import { toggleTheme } from "$lib/theme";
  import {
    ACTIVE_ACCENT,
    GAP_LOOSE,
    HIT_TARGET,
    HOVER_SURFACE,
    ICON,
    ICON_SM,
    ICON_WELL,
    NAV_ITEM,
  } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  type Props = {
    open?: boolean;
    collapsed?: boolean;
    currentView: AppView;
    brand: string;
    projectLabel: string;
    profileLabel: string;
    skillsLabel: string;
    langLabel: string;
    languageLabel: string;
    themeLabel: string;
    closeLabel: string;
    onOpenChange?: (open: boolean) => void;
    onLangToggle?: () => void;
  };

  let {
    open = false,
    collapsed = false,
    currentView,
    brand,
    projectLabel,
    profileLabel,
    skillsLabel,
    langLabel,
    languageLabel,
    themeLabel,
    closeLabel,
    onOpenChange,
    onLangToggle,
  }: Props = $props();

  const themeStore = createTheme();
  const isDark = $derived(themeStore.theme === "dark");
  /** Collapse is desktop-only; mobile drawer always shows labels. */
  const iconOnly = $derived(collapsed && !open);

  function setOpen(next: boolean) {
    onOpenChange?.(next);
  }

  function onNavClick(event: MouseEvent, to: string) {
    if (!shouldHandleSpaClick(event)) return;
    event.preventDefault();
    navigate(to);
    setOpen(false);
  }

  function navClass(active: boolean) {
    return cn(
      NAV_ITEM,
      iconOnly ? "justify-center px-0 py-2.5" : cn(GAP_LOOSE, "px-3 py-2.5"),
      active ? ACTIVE_ACCENT : cn("text-muted-foreground", HOVER_SURFACE),
      "focus-ring"
    );
  }

  const footerIconBtn =
    "inline-flex items-center justify-center self-stretch min-w-11 px-2.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-ring";
</script>

{#if open}
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/50 md:hidden"
    aria-label={closeLabel}
    onclick={() => setOpen(false)}
  ></button>
{/if}

<aside
  class={cn(
    "inset-y-0 inset-s-0 z-50 flex h-svh shrink-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200 motion-reduce:transition-none",
    "fixed top-0 translate-x-0!",
    collapsed ? "md:w-16" : "md:w-64",
    "w-64",
    open ? "translate-x-0" : "max-md:-translate-x-full max-md:rtl:translate-x-full"
  )}
>
  <div
    class={cn(
      "flex shrink-0 items-center py-4",
      iconOnly ? "justify-center px-2" : cn(GAP_LOOSE, "px-4")
    )}
  >
    <a
      href={ROUTES.home}
      class={cn(
        "flex min-w-0 items-center rounded-xl transition-colors hover:opacity-90 focus-ring",
        iconOnly ? "justify-center" : cn("flex-1", GAP_LOOSE)
      )}
      title={brand}
      aria-label={brand}
      onclick={(e) => onNavClick(e, ROUTES.home)}
    >
      <span class={cn(ICON_WELL, "size-11 shrink-0 rounded-xl")} aria-hidden="true">
        <Brain class={ICON} />
      </span>
      {#if !iconOnly}
        <span class="min-w-0 truncate text-xl font-bold text-foreground-bright">
          {brand}
        </span>
      {/if}
    </a>
    <Button
      variant="ghost"
      size="icon-sm"
      class="md:hidden shrink-0"
      onclick={() => setOpen(false)}
      aria-label={closeLabel}
    >
      <X class={ICON} aria-hidden="true" />
    </Button>
  </div>

  <nav class="flex flex-1 flex-col gap-1 p-2" aria-label="Main">
    <a
      href={ROUTES.project}
      class={navClass(currentView === "project")}
      aria-current={currentView === "project" ? "page" : undefined}
      title={projectLabel}
      aria-label={projectLabel}
      onclick={(e) => onNavClick(e, ROUTES.project)}
    >
      <Folder class={cn(ICON, "shrink-0")} aria-hidden="true" />
      {#if !iconOnly}
        <span class="truncate text-start">{projectLabel}</span>
      {/if}
    </a>
    <a
      href={ROUTES.profile}
      class={navClass(currentView === "profile")}
      aria-current={currentView === "profile" ? "page" : undefined}
      title={profileLabel}
      aria-label={profileLabel}
      onclick={(e) => onNavClick(e, ROUTES.profile)}
    >
      <User class={cn(ICON, "shrink-0")} aria-hidden="true" />
      {#if !iconOnly}
        <span class="truncate text-start">{profileLabel}</span>
      {/if}
    </a>
    <a
      href={ROUTES.skills}
      class={navClass(currentView === "skills")}
      aria-current={currentView === "skills" ? "page" : undefined}
      title={skillsLabel}
      aria-label={skillsLabel}
      onclick={(e) => onNavClick(e, ROUTES.skills)}
    >
      <ScrollText class={cn(ICON, "shrink-0")} aria-hidden="true" />
      {#if !iconOnly}
        <span class="truncate text-start">{skillsLabel}</span>
      {/if}
    </a>
  </nav>

  <div class={cn("mt-auto", iconOnly ? "p-2" : "p-3")}>
    {#if iconOnly}
      <div class={cn("flex flex-col items-center", "gap-1")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onclick={onLangToggle}
          aria-label={languageLabel}
          title={`${languageLabel} (${langLabel})`}
        >
          <Languages class={ICON_SM} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onclick={() => toggleTheme()}
          aria-label={themeLabel}
          title={themeLabel}
        >
          {#if isDark}
            <Moon class={ICON} aria-hidden="true" />
          {:else}
            <Sun class={ICON} aria-hidden="true" />
          {/if}
        </Button>
        <a
          href="https://github.com/tickernelz/opencode-mem"
          target="_blank"
          rel="noopener noreferrer"
          class={cn(
            "inline-flex items-center justify-center rounded-xl text-muted-foreground transition-colors",
            HIT_TARGET,
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-ring"
          )}
          title="GitHub"
          aria-label="GitHub"
        >
          <GithubIcon class={ICON} aria-hidden="true" />
        </a>
      </div>
    {:else}
      <div class="flex w-full items-center rounded-xl border border-sidebar-border/80 bg-card/70">
        <button
          type="button"
          class={cn(
            "group flex min-w-0 flex-1 items-center rounded-s-xl px-2.5 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-ring",
            GAP_LOOSE
          )}
          onclick={onLangToggle}
          aria-label={languageLabel}
          title={languageLabel}
        >
          <Languages class={cn(ICON_SM, "shrink-0")} aria-hidden="true" />
          <span class="truncate">{languageLabel}</span>
          <span class="ms-auto text-xs tabular-nums">{langLabel}</span>
        </button>
        <button
          type="button"
          class={cn(footerIconBtn, "border-s border-sidebar-border")}
          onclick={() => toggleTheme()}
          aria-label={themeLabel}
          title={themeLabel}
        >
          {#if isDark}
            <Moon class={ICON} aria-hidden="true" />
          {:else}
            <Sun class={ICON} aria-hidden="true" />
          {/if}
        </button>
        <a
          href="https://github.com/tickernelz/opencode-mem"
          target="_blank"
          rel="noopener noreferrer"
          class={cn(footerIconBtn, "rounded-e-xl border-s border-sidebar-border")}
          title="GitHub"
          aria-label="GitHub"
        >
          <GithubIcon class={ICON} aria-hidden="true" />
        </a>
      </div>
    {/if}
  </div>
</aside>
