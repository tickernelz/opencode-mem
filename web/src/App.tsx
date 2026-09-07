import { useEffect, useState, type MouseEvent } from "react";
import { Loader, Menu, Plus, RefreshCw, Search, Trash, TriangleAlert, X } from "lucide-react";
import { useMemoriesExplorer } from "@/hooks/useMemoriesExplorer";
import { useUserProfile } from "@/hooks/useUserProfile";
import { AiCleanupDialog } from "$lib/components/explorer/AiCleanupDialog";
import { AppSidebar } from "$lib/components/explorer/AppSidebar";
import { EditMemoryDialog } from "$lib/components/explorer/EditMemoryDialog";
import { MemoryList } from "$lib/components/explorer/MemoryList";
import { ProfileView } from "$lib/components/explorer/ProfileView";
import { TagMigrationDialog } from "$lib/components/explorer/TagMigrationDialog";
import { Alert, AlertDescription } from "$lib/components/ui/alert";
import { Button } from "$lib/components/ui/button";
import { Checkbox } from "$lib/components/ui/checkbox";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import { Toaster } from "$lib/components/ui/sonner";
import { Textarea } from "$lib/components/ui/textarea";
import { cycleLanguage, getLanguage, useI18n } from "$lib/i18n";
import { getDisplayedMemoryCount } from "$lib/memory-count";
import { initRouter, navigate, ROUTES, useAppView } from "$lib/router";

const MEMORY_TYPES = [
  "",
  "feature",
  "bug-fix",
  "refactor",
  "architecture",
  "rule",
  "documentation",
  "discussion",
  "analysis",
  "configuration",
] as const;

export default function App() {
  const { t } = useI18n();
  const currentView = useAppView();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [langLabel, setLangLabel] = useState(getLanguage().toUpperCase());

  const explorer = useMemoriesExplorer();
  const profile = useUserProfile();

  useEffect(() => {
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
      if (!explorer.isSearching && currentView === "project") {
        void explorer.loadMemories();
      }
    }, 30000);
    return () => {
      stopRouter();
      clearInterval(refreshTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only init
  }, []);

  useEffect(() => {
    if (currentView === "profile") {
      void profile.loadUserProfile();
    }
  }, [currentView, profile.loadUserProfile]);

  function onLangToggle() {
    setLangLabel(cycleLanguage().toUpperCase());
    void explorer.loadMemories();
    void explorer.loadStats();
    if (currentView === "profile") void profile.loadUserProfile();
  }

  function onHomeClick(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(ROUTES.home);
  }

  return (
    <>
      <Toaster richColors position="bottom-right" />

      <div className="flex min-h-svh bg-background text-foreground">
        <AppSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          currentView={currentView}
          brand={t("brand")}
          projectLabel={t("tab-project")}
          profileLabel={t("tab-profile")}
          langLabel={langLabel}
          languageLabel={t("nav-language")}
          themeLabel={t("nav-theme")}
          closeLabel={t("nav-close")}
          onLangToggle={onLangToggle}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur md:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(true)}
              aria-label={t("nav-menu")}
            >
              <Menu className="size-4" />
            </Button>
            <a
              href={ROUTES.home}
              className="truncate text-sm tracking-wide text-primary"
              onClick={onHomeClick}
            >
              {t("brand")}
            </a>
          </div>

          <div className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-4 md:p-6">
            {explorer.showAuthWarning ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{t("auth-warning-text")}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-base tracking-wide text-primary">
                {currentView === "project" ? t("tab-project") : t("tab-profile")}
              </h1>
              {currentView === "project" ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {t("text-total", {
                      count: getDisplayedMemoryCount(
                        explorer.isSearching,
                        explorer.totalItems,
                        explorer.statsTotal
                      ),
                    })}
                  </span>
                  {explorer.refreshing ? <Loader className="size-3.5 animate-spin" /> : null}
                </div>
              ) : null}
            </div>

            {currentView === "project" ? (
              <>
                <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
                  <div className="space-y-1">
                    <Label htmlFor="tag-filter">{t("label-tag")}</Label>
                    <select
                      id="tag-filter"
                      className="flex h-8 min-w-48 rounded-lg border border-border bg-background px-2 text-sm"
                      value={explorer.selectedTag}
                      onChange={(e) => explorer.onTagFilterChange(e.currentTarget.value)}
                    >
                      <option value="">{t("opt-all-tags")}</option>
                      {explorer.tags.map((tag) => (
                        <option key={tag.tag} value={tag.tag}>
                          {tag.displayName || tag.tag}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-1 items-end gap-1.5 min-w-56">
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="search-input" className="sr-only">
                        {t("placeholder-search")}
                      </Label>
                      <Input
                        id="search-input"
                        placeholder={t("placeholder-search")}
                        value={explorer.searchInput}
                        onChange={(e) => explorer.setSearchInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && explorer.performSearch()}
                      />
                    </div>
                    <Button variant="outline" size="icon" onClick={explorer.performSearch}>
                      <Search className="size-4" />
                    </Button>
                    {explorer.isSearching ? (
                      <Button variant="outline" size="icon" onClick={explorer.clearSearch}>
                        <X className="size-4" />
                      </Button>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="outline" size="sm" onClick={explorer.runCleanup}>
                      <Trash className="size-3.5" />
                      {t("btn-cleanup")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={explorer.runDeduplication}>
                      <RefreshCw className="size-3.5" />
                      {t("btn-deduplicate")}
                    </Button>
                  </div>

                  {explorer.selectedIds.size > 0 ? (
                    <div className="flex w-full flex-wrap items-center gap-2 border-t border-border pt-3">
                      <span className="text-xs text-muted-foreground">
                        {t("text-selected", { count: explorer.selectedIds.size })}
                      </span>
                      <Button variant="secondary" size="xs" onClick={explorer.selectAllCurrentPage}>
                        {t("btn-select-all")}
                      </Button>
                      <Button variant="destructive" size="xs" onClick={explorer.bulkDelete}>
                        {t("btn-delete-selected")}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={explorer.deselectAll}>
                        {t("btn-deselect-all")}
                      </Button>
                    </div>
                  ) : null}
                </div>

                {explorer.migrationNeeded ? (
                  <Alert variant="destructive" className="space-y-3">
                    <TriangleAlert />
                    <AlertDescription className="space-y-3">
                      <p>{explorer.migrationMessage || t("migration-mismatch")}</p>
                      <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                          checked={explorer.migrationConfirmed}
                          onCheckedChange={(v) => explorer.setMigrationConfirmed(v === true)}
                          className="mt-0.5"
                        />
                        <span>{t("migration-understand")}</span>
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={!explorer.migrationConfirmed}
                          onClick={() => explorer.runMigration("fresh-start")}
                        >
                          {t("btn-fresh-start")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!explorer.migrationConfirmed}
                          onClick={() => explorer.runMigration("re-embed")}
                        >
                          {t("btn-reembed")}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}

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
                  onPageChange={(delta) => {
                    const next = explorer.currentPage + delta;
                    explorer.setCurrentPage(next);
                    void explorer.loadMemories({ page: next });
                  }}
                  onPin={explorer.pinMemory}
                  onUnpin={explorer.unpinMemory}
                  onEdit={explorer.openEdit}
                  onDeleteMemory={explorer.deleteMemory}
                  onDeletePrompt={explorer.deletePrompt}
                />

                <section className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <h2 className="text-sm text-muted-foreground">{t("section-add")}</h2>
                  <form className="space-y-3" onSubmit={explorer.addMemory}>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="space-y-1">
                        <Label htmlFor="add-tag">{t("label-tag")}</Label>
                        <select
                          id="add-tag"
                          required
                          className="flex h-8 w-full rounded-lg border border-border bg-background px-2 text-sm"
                          value={explorer.addTag}
                          onChange={(e) => explorer.setAddTag(e.target.value)}
                        >
                          <option value="">{t("opt-select-tag")}</option>
                          {explorer.tags.map((tag) => (
                            <option key={tag.tag} value={tag.tag}>
                              {tag.displayName || tag.tag}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="add-type">{t("label-type")}</Label>
                        <select
                          id="add-type"
                          className="flex h-8 w-full rounded-lg border border-border bg-background px-2 text-sm"
                          value={explorer.addType}
                          onChange={(e) => explorer.setAddType(e.target.value)}
                        >
                          {MEMORY_TYPES.map((type) => (
                            <option key={type || "other"} value={type}>
                              {t(type ? `opt-${type}` : "opt-other")}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="add-tags">{t("label-tags")}</Label>
                        <Input
                          id="add-tags"
                          placeholder={t("placeholder-tags")}
                          value={explorer.addTags}
                          onChange={(e) => explorer.setAddTags(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="add-content">{t("label-content")}</Label>
                      <Textarea
                        id="add-content"
                        rows={4}
                        required
                        placeholder={t("placeholder-content")}
                        value={explorer.addContent}
                        onChange={(e) => explorer.setAddContent(e.target.value)}
                      />
                    </div>
                    <Button type="submit">
                      <Plus className="size-3.5" />
                      {t("btn-add-memory")}
                    </Button>
                  </form>
                </section>
              </>
            ) : (
              <ProfileView
                profile={profile.userProfile}
                loading={profile.loadingProfile}
                onRefresh={profile.refreshProfile}
                onCleanup={() => profile.setAiCleanupOpen(true)}
              />
            )}
          </div>
        </div>
      </div>

      <EditMemoryDialog
        open={explorer.editOpen}
        onOpenChange={explorer.setEditOpen}
        content={explorer.editContent}
        onSave={explorer.saveEdit}
      />
      <TagMigrationDialog
        open={explorer.tagMigrationOpen}
        onOpenChange={explorer.setTagMigrationOpen}
        count={explorer.tagMigrationCount}
        onComplete={() => {
          void explorer.loadMemories();
          void explorer.loadStats();
        }}
      />
      <AiCleanupDialog
        open={profile.aiCleanupOpen}
        onOpenChange={profile.setAiCleanupOpen}
        profile={profile.userProfile}
        onApplied={profile.loadUserProfile}
      />
    </>
  );
}
