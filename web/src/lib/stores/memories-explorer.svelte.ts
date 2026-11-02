import { toast } from "$lib/toast/toast.svelte";
import { fetchAPI, toastApiResult } from "$lib/api";
import { deleteSelectedMemories } from "$lib/bulk-delete";
import { askConfirm } from "$lib/confirm.svelte";
import { groupMemories } from "$lib/group-memories";
import { t } from "$lib/i18n";
import { removeFromSet, toggleInSet } from "$lib/set-utils";
import type { MemoryItem, TagInfo } from "$lib/types";

export function createMemoriesExplorer() {
  let tags = $state<TagInfo[]>([]);
  let memories = $state<MemoryItem[]>([]);
  let selectedIds = $state<Set<string>>(new Set());
  let selectedTags = $state<string[]>([]);
  let searchQuery = $state("");
  let searchInput = $state("");
  let isSearching = $state(false);
  let currentPage = $state(1);
  let totalPages = $state(1);
  let totalItems = $state(0);
  let statsTotal = $state(0);
  let loadingMemories = $state(true);
  let memoriesError = $state<string | null>(null);
  let refreshing = $state(false);
  let showAuthWarning = $state(false);
  let migrationNeeded = $state(false);
  let migrationMessage = $state("");
  let migrationConfirmed = $state(false);
  let tagMigrationOpen = $state(false);
  let tagMigrationCount = $state(0);
  let addOpen = $state(false);
  let addTag = $state("");
  let addType = $state("");
  let addTags = $state<string[]>([]);
  let addContent = $state("");
  let editOpen = $state(false);
  let editId = $state("");
  let editContent = $state("");
  let editType = $state("");
  let editTags = $state<string[]>([]);
  let trashOpen = $state(false);
  let trashLoading = $state(false);
  let trashItems = $state<
    Array<{
      id: string;
      content: string;
      deletedAt: number;
      mergedInto?: string;
      supersededBy?: string;
      projectName?: string;
      containerTag: string;
    }>
  >([]);
  let dreamingBusy = $state(false);

  function snapshot() {
    return { currentPage, isSearching, searchQuery, selectedTags };
  }

  function setSelected(next: Set<string>) {
    selectedIds = new Set(next);
  }

  async function reloadAll() {
    await loadMemories();
    await loadStats();
  }

  async function loadTags() {
    const result = await fetchAPI<{ project: TagInfo[]; user?: TagInfo[] }>("/api/tags");
    if (result.success && result.data) {
      tags = [...(result.data.project || []), ...(result.data.user || [])];
    }
  }

  async function loadStats() {
    const result = await fetchAPI<{ total: number }>("/api/stats");
    if (result.success && result.data) {
      statsTotal = result.data.total;
    }
  }

  async function loadMemories(overrides?: {
    page?: number;
    isSearching?: boolean;
    searchQuery?: string;
    selectedTags?: string[];
  }) {
    const {
      currentPage: page,
      isSearching: searching,
      searchQuery: query,
      selectedTags: tags,
    } = {
      ...snapshot(),
      ...overrides,
      currentPage: overrides?.page ?? snapshot().currentPage,
    };

    refreshing = true;
    memoriesError = null;
    let endpoint = `/api/memories?page=${page}&pageSize=20&includePrompts=true`;
    if (searching) {
      endpoint = `/api/search?q=${encodeURIComponent(query)}&page=${page}&pageSize=20`;
    }
    for (const tag of tags) {
      endpoint += `&tag=${encodeURIComponent(tag)}`;
    }

    const result = await fetchAPI<{
      items: MemoryItem[];
      totalPages: number;
      total: number;
      page: number;
    }>(endpoint);
    refreshing = false;
    loadingMemories = false;

    if (result.success && result.data) {
      memories = result.data.items;
      totalPages = result.data.totalPages;
      totalItems = result.data.total;
      currentPage = result.data.page;
    } else {
      memoriesError = result.error || t("toast-update-failed");
    }
  }

  async function checkMigrationStatus() {
    const result = await fetchAPI<{
      needsMigration: boolean;
      configDimensions: number;
      configModel: string;
      shardMismatches: unknown[];
    }>("/api/migration/detect");
    if (result.success && result.data?.needsMigration) {
      const shardInfo =
        result.data.shardMismatches.length > 0
          ? t("migration-shards-mismatch", { count: result.data.shardMismatches.length })
          : t("migration-dimension-mismatch");
      migrationMessage = t("migration-mismatch-details", {
        configDimensions: result.data.configDimensions,
        configModel: result.data.configModel,
        shardInfo,
      });
      migrationNeeded = true;
    }

    const tagResult = await fetchAPI<{ needsMigration: boolean; count: number }>(
      "/api/migration/tags/detect"
    );
    if (tagResult.success && tagResult.data?.needsMigration) {
      tagMigrationCount = tagResult.data.count;
      tagMigrationOpen = true;
    }
  }

  async function checkAuthWarning() {
    try {
      const response = await fetch("/api/health", { credentials: "same-origin" });
      if (!response.ok) return;
      const data = await response.json();
      const authEnabled = data?.authEnabled === true;
      if (authEnabled) {
        showAuthWarning = false;
        return;
      }
      const host = window.location.hostname.toLowerCase();
      const loopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1" ||
        (host.startsWith("::ffff:") && host.endsWith("127.0.0.1"));
      showAuthWarning = !loopback;
    } catch {
      /* ignore */
    }
  }

  function performSearch() {
    const query = searchInput.trim();
    if (!query) {
      clearSearch();
      return;
    }
    searchQuery = query;
    isSearching = true;
    currentPage = 1;
    void loadMemories({
      page: 1,
      isSearching: true,
      searchQuery: query,
    });
  }

  function clearSearch() {
    searchQuery = "";
    searchInput = "";
    isSearching = false;
    currentPage = 1;
    void loadMemories({
      page: 1,
      isSearching: false,
      searchQuery: "",
    });
  }

  function onTagFilterChange(value: string[]) {
    selectedTags = value;
    currentPage = 1;
    isSearching = false;
    searchQuery = "";
    searchInput = "";
    void loadMemories({
      page: 1,
      isSearching: false,
      searchQuery: "",
      selectedTags: value,
    });
  }

  function onSelect(id: string, selected: boolean) {
    setSelected(toggleInSet(selectedIds, id, selected));
  }

  function selectAllCurrentPage() {
    const next = new Set(selectedIds);
    for (const group of groupMemories(memories)) {
      next.add(group.isPair ? group.memory.id : group.item.id);
    }
    setSelected(next);
  }

  function deselectAll() {
    setSelected(new Set());
  }

  async function addMemory(event?: Event) {
    event?.preventDefault();
    const content = addContent.trim();
    if (!content || !addTag) {
      toast.error(t("toast-add-error"));
      return;
    }
    const tagsList = addTags.map((x) => x.trim()).filter(Boolean);
    const result = await fetchAPI("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        content,
        containerTag: addTag,
        type: addType || undefined,
        tags: tagsList,
      }),
    });
    await toastApiResult(result, {
      successKey: "toast-add-success",
      failKey: "toast-add-failed",
      onSuccess: async () => {
        addContent = "";
        addTags = [];
        addType = "";
        addOpen = false;
        await reloadAll();
      },
    });
  }

  function openEdit(id: string) {
    const memory = memories.find((m) => m.id === id && m.type === "memory");
    if (!memory) return;
    editId = id;
    editContent = memory.content;
    editType = memory.memoryType || "";
    editTags = [...(memory.tags || [])];
    editOpen = true;
  }

  function openEditWithData(data: { id: string; content: string; type?: string; tags?: string[] }) {
    editId = data.id;
    editContent = data.content;
    editType = data.type || "";
    editTags = [...(data.tags || [])];
    editOpen = true;
  }

  async function saveEdit(content: string, nextTags?: string[], nextType?: string) {
    const tags = nextTags ?? editTags;
    const type = nextType ?? editType;
    const result = await fetchAPI(`/api/memories/${editId}`, {
      method: "PUT",
      body: JSON.stringify({ content, tags, type: type || undefined }),
    });
    await toastApiResult(result, {
      successKey: "toast-update-success",
      failKey: "toast-update-failed",
      onSuccess: async () => {
        editOpen = false;
        await loadMemories();
      },
    });
  }

  async function updateMemoryTags(id: string, nextTags: string[]) {
    const memory = memories.find((m) => m.id === id && m.type === "memory");
    if (!memory) return;
    memories = memories.map((item) => (item.id === id ? { ...item, tags: nextTags } : item));
    const result = await fetchAPI(`/api/memories/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content: memory.content, tags: nextTags }),
    });
    if (!result.success) {
      await loadMemories();
      await toastApiResult(result, {
        failKey: "toast-update-failed",
      });
      return;
    }
    await toastApiResult(result, {
      successKey: "toast-update-success",
      failKey: "toast-update-failed",
    });
  }

  async function deleteByEndpoint(
    id: string,
    endpoint: string,
    confirmKey: "confirm-delete" | "confirm-delete-pair" | "confirm-delete-prompt"
  ) {
    const ok = await askConfirm({
      title: t("confirm-delete-title"),
      detail: t(confirmKey),
      confirmLabel: t("btn-delete"),
      tone: "danger",
    });
    if (!ok) return;
    const result = await fetchAPI(endpoint, { method: "DELETE" });
    await toastApiResult(result, {
      successKey: "toast-delete-success",
      failKey: "toast-delete-failed",
      onSuccess: async () => {
        setSelected(removeFromSet(selectedIds, id));
        await reloadAll();
      },
    });
  }

  async function deleteMemory(id: string, isLinked: boolean) {
    await deleteByEndpoint(
      id,
      `/api/memories/${id}?cascade=true`,
      isLinked ? "confirm-delete-pair" : "confirm-delete"
    );
  }

  async function deletePrompt(id: string, isLinked: boolean) {
    await deleteByEndpoint(
      id,
      `/api/prompts/${id}?cascade=true`,
      isLinked ? "confirm-delete-prompt" : "confirm-delete"
    );
  }

  async function bulkDelete() {
    if (selectedIds.size === 0) return;
    const ok = await askConfirm({
      title: t("confirm-bulk-delete-title"),
      detail: t("confirm-bulk-delete", { count: selectedIds.size }),
      confirmLabel: t("btn-delete-selected"),
      tone: "danger",
    });
    if (!ok) return;

    const result = await deleteSelectedMemories(
      Array.from(selectedIds),
      fetchAPI,
      memories.map((m) => ({
        id: m.id,
        linkedMemoryId: m.linkedMemoryId,
        linkedPromptId: m.linkedPromptId,
      }))
    );
    if (!result.success) {
      if (result.deletedIds.length > 0) {
        let next = selectedIds;
        for (const id of result.deletedIds) next = removeFromSet(next, id);
        setSelected(next);
        await reloadAll();
      }
      toast.error(result.error || t("toast-bulk-delete-failed"));
      return;
    }

    toast.success(t("toast-bulk-delete-success"));
    setSelected(new Set());
    await reloadAll();
  }

  async function setPin(id: string, pinned: boolean) {
    const result = await fetchAPI(`/api/memories/${id}/${pinned ? "pin" : "unpin"}`, {
      method: "POST",
    });
    await toastApiResult(result, {
      successKey: "toast-update-success",
      failKey: "toast-update-failed",
      onSuccess: () => loadMemories(),
    });
  }

  async function pinMemory(id: string) {
    await setPin(id, true);
  }

  async function unpinMemory(id: string) {
    await setPin(id, false);
  }

  async function confirmThenPost(
    path: string,
    confirmKey: "confirm-cleanup" | "confirm-dedup",
    titleKey: "confirm-cleanup-title" | "confirm-dedup-title",
    confirmLabelKey: "btn-cleanup" | "btn-deduplicate",
    statusKey: "status-cleanup" | "status-dedup",
    successKey: "toast-cleanup-success" | "toast-dedup-success",
    failKey: "toast-cleanup-failed" | "toast-dedup-failed"
  ) {
    const ok = await askConfirm({
      title: t(titleKey),
      detail: t(confirmKey),
      confirmLabel: t(confirmLabelKey),
      tone: "danger",
    });
    if (!ok) return;
    toast.info(t(statusKey));
    const result = await fetchAPI(path, { method: "POST" });
    await toastApiResult(result, {
      successKey,
      failKey,
      onSuccess: () => reloadAll(),
    });
  }

  async function runCleanup() {
    await confirmThenPost(
      "/api/cleanup",
      "confirm-cleanup",
      "confirm-cleanup-title",
      "btn-cleanup",
      "status-cleanup",
      "toast-cleanup-success",
      "toast-cleanup-failed"
    );
  }

  async function runDeduplication() {
    await confirmThenPost(
      "/api/deduplicate",
      "confirm-dedup",
      "confirm-dedup-title",
      "btn-deduplicate",
      "status-dedup",
      "toast-dedup-success",
      "toast-dedup-failed"
    );
  }

  async function openTrash() {
    trashOpen = true;
    trashLoading = true;
    const result = await fetchAPI<typeof trashItems>("/api/memories/trash");
    trashLoading = false;
    if (result.success && result.data) {
      trashItems = result.data;
    } else {
      trashItems = [];
      toast.error(result.error || t("toast-trash-load-failed"));
    }
  }

  async function restoreTrashItem(id: string) {
    const result = await fetchAPI(`/api/memories/${id}/restore`, { method: "POST" });
    await toastApiResult(result, {
      successKey: "toast-restore-success",
      failKey: "toast-restore-failed",
      onSuccess: async () => {
        trashItems = trashItems.filter((item) => item.id !== id);
        await reloadAll();
      },
    });
  }

  async function runDreaming() {
    if (dreamingBusy) return;
    const ok = await askConfirm({
      title: t("confirm-dreaming-title"),
      detail: t("confirm-dreaming"),
      confirmLabel: t("btn-dreaming"),
      tone: "danger",
    });
    if (!ok) return;
    dreamingBusy = true;
    toast.info(t("status-dreaming"));
    try {
      const result = await fetchAPI<{
        groupsFailed?: number;
        groupsConsidered?: number;
        groupsMerged?: number;
      }>("/api/dreaming/run", { method: "POST" });
      if (!result.success && result.error === "already_running") {
        toast.info(t("toast-dreaming-already-running"));
        return;
      }
      if (!result.success && result.error === "dreaming_provider_unavailable") {
        toast.error(t("toast-dreaming-failed"));
        return;
      }
      if (result.success && (result.data?.groupsFailed ?? 0) > 0) {
        const failed = result.data?.groupsFailed ?? 0;
        const considered = result.data?.groupsConsidered ?? 0;
        const merged = result.data?.groupsMerged ?? 0;
        const partialMsg = t("toast-dreaming-partial", { failed, considered });
        // Nothing merged + any failures: treat as error (includes provider abort).
        // Mixed merge+fail stays a warning.
        if (merged === 0) {
          toast.error(partialMsg);
        } else {
          toast.warning(partialMsg);
        }
        await reloadAll();
        return;
      }
      await toastApiResult(result, {
        successKey: "toast-dreaming-success",
        failKey: "toast-dreaming-failed",
        onSuccess: () => reloadAll(),
      });
    } finally {
      dreamingBusy = false;
    }
  }

  async function runMigration(strategy: "fresh-start" | "re-embed") {
    if (!migrationConfirmed) {
      toast.error(t("toast-migration-failed"));
      return;
    }
    const strategyLabel = strategy === "fresh-start" ? t("btn-fresh-start") : t("btn-reembed");
    const ok = await askConfirm({
      title: t("confirm-migration-title"),
      detail: t("confirm-migration", { strategy: strategyLabel }),
      confirmLabel: t("btn-start-migration"),
      tone: "danger",
    });
    if (!ok) return;
    toast.info(t("status-migration-init"));
    const result = await fetchAPI("/api/migration/run", {
      method: "POST",
      body: JSON.stringify({ strategy }),
    });
    await toastApiResult(result, {
      successKey: "toast-migration-success",
      failKey: "toast-migration-failed",
      onSuccess: async () => {
        migrationNeeded = false;
        migrationConfirmed = false;
        await reloadAll();
      },
    });
  }

  return {
    get tags() {
      return tags;
    },
    get memories() {
      return memories;
    },
    get selectedIds() {
      return selectedIds;
    },
    get selectedTags() {
      return selectedTags;
    },
    get searchInput() {
      return searchInput;
    },
    set searchInput(v: string) {
      searchInput = v;
    },
    get isSearching() {
      return isSearching;
    },
    get currentPage() {
      return currentPage;
    },
    set currentPage(v: number) {
      currentPage = v;
    },
    get totalPages() {
      return totalPages;
    },
    get totalItems() {
      return totalItems;
    },
    get statsTotal() {
      return statsTotal;
    },
    get loadingMemories() {
      return loadingMemories;
    },
    get memoriesError() {
      return memoriesError;
    },
    get refreshing() {
      return refreshing;
    },
    get showAuthWarning() {
      return showAuthWarning;
    },
    get migrationNeeded() {
      return migrationNeeded;
    },
    get migrationMessage() {
      return migrationMessage;
    },
    get migrationConfirmed() {
      return migrationConfirmed;
    },
    set migrationConfirmed(v: boolean) {
      migrationConfirmed = v;
    },
    get tagMigrationOpen() {
      return tagMigrationOpen;
    },
    set tagMigrationOpen(v: boolean) {
      tagMigrationOpen = v;
    },
    get tagMigrationCount() {
      return tagMigrationCount;
    },
    get editOpen() {
      return editOpen;
    },
    set editOpen(v: boolean) {
      editOpen = v;
    },
    get editContent() {
      return editContent;
    },
    get editType() {
      return editType;
    },
    get addOpen() {
      return addOpen;
    },
    set addOpen(v: boolean) {
      addOpen = v;
    },
    get addTag() {
      return addTag;
    },
    set addTag(v: string) {
      addTag = v;
    },
    get addType() {
      return addType;
    },
    set addType(v: string) {
      addType = v;
    },
    get addTags() {
      return addTags;
    },
    set addTags(v: string[]) {
      addTags = v;
    },
    get editTags() {
      return editTags;
    },
    set editTags(v: string[]) {
      editTags = v;
    },
    get addContent() {
      return addContent;
    },
    set addContent(v: string) {
      addContent = v;
    },
    get trashOpen() {
      return trashOpen;
    },
    set trashOpen(v: boolean) {
      trashOpen = v;
    },
    get trashLoading() {
      return trashLoading;
    },
    get trashItems() {
      return trashItems;
    },
    get dreamingBusy() {
      return dreamingBusy;
    },
    get knownTags() {
      const set = new Set<string>();
      for (const memory of memories) {
        for (const tag of memory.tags || []) {
          const trimmed = tag.trim();
          if (trimmed) set.add(trimmed);
        }
      }
      for (const tag of addTags) {
        const trimmed = tag.trim();
        if (trimmed) set.add(trimmed);
      }
      return [...set].sort((a, b) => a.localeCompare(b));
    },
    loadTags,
    loadStats,
    loadMemories,
    checkMigrationStatus,
    checkAuthWarning,
    performSearch,
    clearSearch,
    onTagFilterChange,
    onSelect,
    selectAllCurrentPage,
    deselectAll,
    addMemory,
    openEdit,
    openEditWithData,
    saveEdit,
    updateMemoryTags,
    deleteMemory,
    deletePrompt,
    bulkDelete,
    pinMemory,
    unpinMemory,
    runCleanup,
    runDeduplication,
    openTrash,
    restoreTrashItem,
    runDreaming,
    runMigration,
  };
}

export type MemoriesExplorer = ReturnType<typeof createMemoriesExplorer>;
