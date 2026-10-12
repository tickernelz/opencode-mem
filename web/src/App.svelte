<script lang="ts">
  import Loader from "@lucide/svelte/icons/loader";
  import Menu from "@lucide/svelte/icons/menu";
  import PanelLeftClose from "@lucide/svelte/icons/panel-left-close";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import AiCleanupDialog from "$lib/components/explorer/AiCleanupDialog.svelte";
  import AddMemoryDialog from "$lib/components/explorer/AddMemoryDialog.svelte";
  import AppSidebar from "$lib/components/explorer/AppSidebar.svelte";
  import EditMemoryDialog from "$lib/components/explorer/EditMemoryDialog.svelte";
  import MemoryList from "$lib/components/explorer/MemoryList.svelte";
  import ProfileView from "$lib/components/explorer/ProfileView.svelte";
  import SkillDialog from "$lib/components/explorer/SkillDialog.svelte";
  import SkillsView from "$lib/components/explorer/SkillsView.svelte";
  import TagMigrationDialog from "$lib/components/explorer/TagMigrationDialog.svelte";
  import TagFilter from "$lib/components/explorer/TagFilter.svelte";
  import Alert from "$lib/components/ui/alert.svelte";
  import AlertDescription from "$lib/components/ui/alert-description.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Checkbox from "$lib/components/ui/checkbox.svelte";
  import SearchInput from "$lib/components/ui/search-input.svelte";
  import ToastStack from "$lib/components/ui/toast-stack.svelte";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import { cycleLanguage, getLanguage } from "$lib/i18n";
  import { setI18nContext } from "$lib/i18n/context.svelte";
  import { getDisplayedMemoryCount } from "$lib/memory-count";
  import { initRouter, navigate, ROUTES, shouldHandleSpaClick } from "$lib/router";
  import { createRouter } from "$lib/router.svelte";
  import { createMemoriesExplorer } from "$lib/stores/memories-explorer.svelte";
  import { createSkillsStore } from "$lib/stores/skills.svelte";
  import { createUserProfile } from "$lib/stores/user-profile.svelte";
  import {
    GAP,
    GAP_LOOSE,
    HEADER_GUTTER,
    ICON,
    ICON_SM,
    META_CHIP,
    PAGE_SHELL,
    PAGE_TOOLBAR,
    STACK,
  } from "$lib/ui/styles";
  import { cn } from "$lib/utils";

  const SIDEBAR_COLLAPSED_KEY = "opencode-mem-sidebar-collapsed";

  function readCollapsed(): boolean {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  const i18n = setI18nContext();
  const router = createRouter();
  const explorer = createMemoriesExplorer();
  const profile = createUserProfile();
  const skills = createSkillsStore();

  let sidebarOpen = $state(false);
  let sidebarCollapsed = $state(readCollapsed());
  let langLabel = $state(getLanguage().toUpperCase());
  let headerScrolled = $state(false);

  const pageTitle = $derived(
    router.view === "project"
      ? i18n.t("tab-project")
      : router.view === "skills"
        ? i18n.t("tab-skills")
        : i18n.t("tab-profile")
  );

  $effect(() => {
    const onScroll = () => {
      headerScrolled = window.scrollY > 8;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  });

  $effect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  });

  $effect(() => {
    const stopRouter = initRouter();
    void (async () => {
      await explorer.loadTags();
      await explorer.loadMemories();
      await explorer.loadStats();
      await explorer.checkMigrationStatus();
      await explorer.checkAuthWarning();
    })();
    const refreshTimer = setInterval(() => {
      void explorer.loadStats();
      if (!explorer.isSearching && router.view === "project") {
        void explorer.loadMemories();
      }
    }, 30000);
    return () => {
      stopRouter();
      clearInterval(refreshTimer);
    };
  });

  $effect(() => {
    if (router.view === "profile") {
      void profile.loadUserProfile();
    }
    if (router.view === "skills") {
      void skills.loadSkills();
    }
  });

  function onLangToggle() {
    langLabel = cycleLanguage().toUpperCase();
    void explorer.loadMemories();
    void explorer.loadStats();
    if (router.view === "profile") void profile.loadUserProfile();
    if (router.view === "skills") void skills.loadSkills();
  }

  function onHomeClick(event: MouseEvent) {
    if (!shouldHandleSpaClick(event)) return;
    event.preventDefault();
    navigate(ROUTES.home);
  }
</script>

<ToastStack />
<ConfirmDialog />

<div class="flex min-h-svh bg-background text-foreground">
  <AppSidebar
    open={sidebarOpen}
    collapsed={sidebarCollapsed}
    onOpenChange={(open) => (sidebarOpen = open)}
    currentView={router.view}
    brand={i18n.t("brand")}
    projectLabel={i18n.t("tab-project")}
    profileLabel={i18n.t("tab-profile")}
    skillsLabel={i18n.t("tab-skills")}
    {langLabel}
    languageLabel={i18n.t("nav-language")}
    themeLabel={i18n.t("nav-theme")}
    closeLabel={i18n.t("nav-close")}
    {onLangToggle}
  />
  <!-- Desktop spacer: sidebar is fixed and out of flow -->
  <div
    class={cn(
      "hidden shrink-0 transition-[width] duration-200 md:block",
      sidebarCollapsed ? "w-16" : "w-64"
    )}
    aria-hidden="true"
  ></div>

  <div class="flex min-w-0 flex-1 flex-col">
    <header
      class={cn(
        "fixed top-0 inset-e-0 z-30 flex h-14 items-center border-b transition-[background-color,border-color,backdrop-filter,inset-inline-start] duration-200",
        "inset-s-0",
        sidebarCollapsed ? "md:inset-s-16" : "md:inset-s-64",
        headerScrolled
          ? "border-border/40 bg-background/55 backdrop-blur-xl"
          : "border-border bg-background/95 backdrop-blur-md"
      )}
    >
      <div class={`flex w-full items-center ${GAP_LOOSE} ${HEADER_GUTTER}`}>
        <Button
          variant="ghost"
          size="icon"
          class="md:hidden shrink-0"
          onclick={() => (sidebarOpen = true)}
          aria-label={i18n.t("nav-menu")}
        >
          <Menu class={ICON} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="hidden md:inline-flex shrink-0"
          onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
          aria-label={sidebarCollapsed ? i18n.t("nav-expand") : i18n.t("nav-collapse")}
          title={sidebarCollapsed ? i18n.t("nav-expand") : i18n.t("nav-collapse")}
          aria-expanded={!sidebarCollapsed}
        >
          {#if sidebarCollapsed}
            <PanelLeftOpen class={ICON} aria-hidden="true" />
          {:else}
            <PanelLeftClose class={ICON} aria-hidden="true" />
          {/if}
        </Button>
        <h1 class="min-w-0 flex-1 truncate text-xl font-bold tracking-tight text-foreground-bright">
          <a
            href={ROUTES.home}
            class="hover:opacity-90 md:pointer-events-none"
            onclick={onHomeClick}
          >
            {pageTitle}
          </a>
        </h1>
        {#if router.view === "project"}
          <div class={cn("flex shrink-0 items-center text-xs text-muted-foreground", GAP)}>
            <span class={META_CHIP}>
              {i18n.t("text-total", {
                count: getDisplayedMemoryCount(
                  explorer.isSearching,
                  explorer.totalItems,
                  explorer.statsTotal,
                  explorer.selectedTags.length > 0
                ),
              })}
            </span>
            {#if explorer.refreshing}
              <Loader class={cn(ICON_SM, "animate-spin")} aria-hidden="true" />
            {/if}
          </div>
        {:else if router.view === "skills"}
          <span class={META_CHIP}>
            {i18n.t("text-total", {
              count: skills.isSearching ? skills.filteredSkills.length : skills.skills.length,
            })}
          </span>
        {/if}
      </div>
    </header>
    <div class="h-14 shrink-0" aria-hidden="true"></div>

    <div class={PAGE_SHELL}>
      {#if explorer.showAuthWarning}
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{i18n.t("auth-warning-text")}</AlertDescription>
        </Alert>
      {/if}

      {#if router.view === "project"}
        <div class={PAGE_TOOLBAR}>
          <div class={cn("flex w-full min-w-0 items-center", GAP)}>
            <TagFilter
              tags={explorer.tags}
              value={explorer.selectedTags}
              allLabel={i18n.t("opt-all-tags")}
              filterLabel={i18n.t("btn-filter")}
              clearLabel={i18n.t("btn-filter-clear")}
              searchPlaceholder={i18n.t("placeholder-filter")}
              onChange={explorer.onTagFilterChange}
            />

            <div class="flex min-w-0 flex-1 justify-center px-1">
              <SearchInput
                id="search-input"
                class="w-full max-w-xl"
                placeholder={i18n.t("placeholder-search")}
                bind:value={explorer.searchInput}
                showClear={explorer.isSearching}
                onClear={explorer.clearSearch}
                onSearch={explorer.performSearch}
                onkeydown={(e) => e.key === "Enter" && explorer.performSearch()}
              />
            </div>

            <div class={cn("flex shrink-0 items-center", GAP)}>
              <Button type="button" variant="outline" onclick={explorer.runCleanup}>
                <Trash2 class={ICON_SM} aria-hidden="true" />
                {i18n.t("btn-cleanup")}
              </Button>
              <Button type="button" variant="outline" onclick={explorer.runDeduplication}>
                <RefreshCw class={ICON_SM} aria-hidden="true" />
                {i18n.t("btn-deduplicate")}
              </Button>
              <Button
                variant="default"
                size="icon"
                aria-label={i18n.t("btn-add-memory")}
                title={i18n.t("btn-add-memory")}
                onclick={() => (explorer.addOpen = true)}
              >
                <Plus class={ICON} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>

        {#if explorer.migrationNeeded}
          <Alert variant="destructive" class={STACK}>
            <TriangleAlert aria-hidden="true" />
            <AlertDescription class={STACK}>
              <p>{explorer.migrationMessage || i18n.t("migration-mismatch")}</p>
              <label class={cn("flex items-start text-sm", GAP)}>
                <Checkbox
                  checked={explorer.migrationConfirmed}
                  onCheckedChange={(v) => (explorer.migrationConfirmed = v === true)}
                  class="mt-0.5"
                />
                <span>{i18n.t("migration-understand")}</span>
              </label>
              <div class={cn("flex flex-wrap", GAP)}>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!explorer.migrationConfirmed}
                  onclick={() => explorer.runMigration("fresh-start")}
                >
                  {i18n.t("btn-fresh-start")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!explorer.migrationConfirmed}
                  onclick={() => explorer.runMigration("re-embed")}
                >
                  {i18n.t("btn-reembed")}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        {/if}

        <MemoryList
          memories={explorer.memories}
          selectedIds={explorer.selectedIds}
          currentPage={explorer.currentPage}
          totalPages={explorer.totalPages}
          totalItems={explorer.totalItems}
          isSearching={explorer.isSearching}
          loading={explorer.loadingMemories}
          error={explorer.memoriesError}
          onSelect={explorer.onSelect}
          onSelectAllPage={explorer.selectAllCurrentPage}
          onDeselectAll={explorer.deselectAll}
          onBulkDelete={explorer.bulkDelete}
          onPageChange={(delta) => {
            const next = explorer.currentPage + delta;
            explorer.currentPage = next;
            void explorer.loadMemories({ page: next });
          }}
          onPin={explorer.pinMemory}
          onUnpin={explorer.unpinMemory}
          onEdit={explorer.openEdit}
          onDeleteMemory={explorer.deleteMemory}
          onDeletePrompt={explorer.deletePrompt}
          onTagsChange={explorer.updateMemoryTags}
          knownTags={explorer.knownTags}
        />
      {:else if router.view === "skills"}
        <div class={PAGE_TOOLBAR}>
          <div class={cn("flex w-full min-w-0 items-center", GAP)}>
            <div class="flex min-w-0 flex-1 justify-center px-1">
              <SearchInput
                id="skills-search-input"
                class="w-full max-w-xl"
                placeholder={i18n.t("placeholder-search-skills")}
                bind:value={skills.searchInput}
                showClear={skills.isSearching}
                onClear={skills.clearSearch}
              />
            </div>
            <div class={cn("flex shrink-0 items-center", GAP)}>
              <Button
                variant="default"
                size="icon"
                aria-label={i18n.t("btn-add-skill")}
                title={i18n.t("btn-add-skill")}
                onclick={skills.openCreate}
              >
                <Plus class={ICON} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>
        <SkillsView
          skills={skills.skills}
          filtered={skills.filteredSkills}
          loading={skills.loading}
          onEdit={skills.openEdit}
          onDelete={skills.deleteSkill}
        />
      {:else}
        <ProfileView
          profile={profile.userProfile}
          loading={profile.loadingProfile}
          onRefresh={profile.refreshProfile}
          onCleanup={() => (profile.aiCleanupOpen = true)}
        />
      {/if}
    </div>
  </div>
</div>

<SkillDialog
  bind:open={skills.dialogOpen}
  editing={skills.editingId !== null}
  bind:draft={skills.draft}
  onOpenChange={(open) => (skills.dialogOpen = open)}
  onSave={skills.saveSkill}
/>

<AddMemoryDialog
  open={explorer.addOpen}
  onOpenChange={(open) => (explorer.addOpen = open)}
  tags={explorer.tags}
  knownTags={explorer.knownTags}
  bind:tag={explorer.addTag}
  bind:type={explorer.addType}
  bind:contentTags={explorer.addTags}
  bind:content={explorer.addContent}
  onSubmit={explorer.addMemory}
/>
<EditMemoryDialog
  open={explorer.editOpen}
  onOpenChange={(open) => (explorer.editOpen = open)}
  content={explorer.editContent}
  type={explorer.editType}
  tags={explorer.editTags}
  knownTags={explorer.knownTags}
  onSave={explorer.saveEdit}
/>
<TagMigrationDialog
  open={explorer.tagMigrationOpen}
  onOpenChange={(open) => (explorer.tagMigrationOpen = open)}
  count={explorer.tagMigrationCount}
  onComplete={() => {
    void explorer.loadMemories();
    void explorer.loadStats();
  }}
/>
<AiCleanupDialog
  open={profile.aiCleanupOpen}
  onOpenChange={(open) => (profile.aiCleanupOpen = open)}
  profile={profile.userProfile}
  onApplied={profile.loadUserProfile}
/>
