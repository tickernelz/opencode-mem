const API_BASE = "";

const state = {
  tags: { project: [] },
  memories: [],
  currentPage: 1,
  pageSize: 20,
  totalPages: 1,
  totalItems: 0,
  selectedTag: "",
  currentView: "project",
  searchQuery: "",
  isSearching: false,
  selectedMemories: new Set(),
  autoRefreshInterval: null,
  userProfile: null,
  profilePages: { pref: 1, pat: 1, wf: 1 },
};

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

function renderMarkdown(markdown) {
  const html = marked.parse(markdown);
  return DOMPurify.sanitize(html);
}

async function fetchAPI(endpoint, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutMs =
      options.timeout ||
      (options.method === "POST" && endpoint.includes("/ai-cleanup") ? 180000 : 60000);
    const { timeout: _, ...fetchOptions } = options;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(API_BASE + endpoint, {
      ...fetchOptions,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("API Error:", error);
    return { success: false, error: error.message };
  }
}

async function loadTags() {
  const result = await fetchAPI("/api/tags");
  if (result.success) {
    state.tags = result.data;
    populateTagDropdowns();
  }
}

function populateTagDropdowns() {
  const tagFilter = document.getElementById("tag-filter");
  const addTag = document.getElementById("add-tag");

  tagFilter.innerHTML = `<option value="">${t("opt-all-tags")}</option>`;
  addTag.innerHTML = `<option value="">${t("opt-select-tag")}</option>`;

  const scopeTags = state.tags.project;

  scopeTags.forEach((tagInfo) => {
    const displayText = tagInfo.displayName || tagInfo.tag;
    const shortDisplay =
      displayText.length > 50 ? displayText.substring(0, 50) + "..." : displayText;

    const option1 = document.createElement("option");
    option1.value = tagInfo.tag;
    option1.textContent = shortDisplay;
    tagFilter.appendChild(option1);

    const option2 = document.createElement("option");
    option2.value = tagInfo.tag;
    option2.textContent = shortDisplay;
    addTag.appendChild(option2);
  });
}

function renderMemories() {
  const container = document.getElementById("memories-list");

  if (state.memories.length === 0) {
    container.innerHTML = `<div class="empty-state">${t("empty-memories")}</div>`;
    return;
  }

  container.innerHTML = groupMemories(state.memories)
    .map((group) => {
      if (group.isPair) {
        return renderCombinedCard(group);
      } else if (group.type === "prompt") {
        return renderPromptCard(group.item);
      } else {
        return renderMemoryCard(group.item);
      }
    })
    .join("");

  document.querySelectorAll(".memory-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", handleCheckboxChange);
  });

  lucide.createIcons();
}

function groupMemories(items) {
  const map = new Map();
  const pairs = [];
  const processed = new Set();

  items.forEach((item) => map.set(item.id, item));

  items.forEach((item) => {
    if (processed.has(item.id)) return;

    if (item.type === "memory" && item.linkedPromptId && map.has(item.linkedPromptId)) {
      const prompt = map.get(item.linkedPromptId);
      pairs.push({ isPair: true, memory: item, prompt: prompt });
      processed.add(item.id);
      processed.add(prompt.id);
    } else if (item.type === "prompt" && item.linkedMemoryId && map.has(item.linkedMemoryId)) {
      const memory = map.get(item.linkedMemoryId);
      pairs.push({ isPair: true, memory: memory, prompt: item });
      processed.add(item.id);
      processed.add(memory.id);
    } else {
      pairs.push({ isPair: false, type: item.type, item: item });
      processed.add(item.id);
    }
  });

  return pairs.sort((a, b) => {
    const timeA = a.isPair ? a.memory.createdAt : a.item.createdAt;
    const timeB = b.isPair ? b.memory.createdAt : b.item.createdAt;
    return new Date(timeB) - new Date(timeA);
  });
}

function renderCombinedCard(pair) {
  const { memory, prompt } = pair;
  const isSelected = state.selectedMemories.has(memory.id);
  const isPinned = memory.isPinned || false;
  const similarityHtml =
    memory.similarity !== undefined
      ? `<span class="similarity-score">${Math.round(memory.similarity * 100)}%</span>`
      : "";

  const tagsHtml =
    memory.tags && memory.tags.length > 0
      ? `<div class="tags-list">${memory.tags.map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

  const pinButton = isPinned
    ? `<button class="btn-pin pinned" onclick="unpinMemory('${memory.id}')" title="Unpin"><i data-lucide="pin" class="icon icon-filled"></i></button>`
    : `<button class="btn-pin" onclick="pinMemory('${memory.id}')" title="Pin"><i data-lucide="pin" class="icon"></i></button>`;

  const createdDate = formatDate(memory.createdAt);
  const updatedDate =
    memory.updatedAt && memory.updatedAt !== memory.createdAt ? formatDate(memory.updatedAt) : null;

  const dateInfo = updatedDate
    ? `<span>${t("date-created")} ${createdDate}</span><span>${t("date-updated")} ${updatedDate}</span>`
    : `<span>${t("date-created")} ${createdDate}</span>`;
  return `
    <div class="combined-card ${isSelected ? "selected" : ""} ${isPinned ? "pinned" : ""}" data-id="${memory.id}">
      <div class="combined-prompt-section">
        <div class="combined-header">
          <span class="badge badge-prompt">${t("badge-prompt")}</span>
          <span class="prompt-date">${formatDate(prompt.createdAt)}</span>
        </div>
        <div class="prompt-content">${escapeHtml(prompt.content)}</div>
      </div>
      
      <div class="combined-divider">
        <i data-lucide="arrow-down" class="divider-icon"></i>
      </div>

      <div class="combined-memory-section">
        <div class="memory-header">
          <div class="meta">
            <input type="checkbox" class="memory-checkbox" data-id="${memory.id}" ${isSelected ? "checked" : ""} />
            <span class="badge badge-memory">${t("badge-memory")}</span>
            ${memory.memoryType ? `<span class="badge badge-type">${escapeHtml(memory.memoryType)}</span>` : ""}
            ${similarityHtml}
            ${isPinned ? `<span class="badge badge-pinned">${t("badge-pinned")}</span>` : ""}
            <span class="memory-display-name">${escapeHtml(memory.displayName || memory.id)}</span>
          </div>
          <div class="memory-actions">
            ${pinButton}
            <button class="btn-edit" onclick="editMemory('${memory.id}')"><i data-lucide="edit-3" class="icon"></i></button>
            <button class="btn-delete" onclick="deleteMemoryWithLink('${memory.id}', true)">
              <i data-lucide="trash-2" class="icon"></i> ${t("btn-delete-pair")}
            </button>
          </div>
        </div>
        ${tagsHtml}
        <div class="memory-content markdown-content">${renderMarkdown(memory.content)}</div>
        <div class="memory-footer">
          ${dateInfo}
          <span>ID: ${memory.id}</span>
        </div>
      </div>
    </div>
  `;
}

function renderPromptCard(prompt) {
  const isLinked = !!prompt.linkedMemoryId;
  const isSelected = state.selectedMemories.has(prompt.id);
  const promptDate = formatDate(prompt.createdAt);

  return `
    <div class="prompt-card ${isSelected ? "selected" : ""}" data-id="${prompt.id}">
      <div class="prompt-header">
        <div class="meta">
          <input type="checkbox" class="memory-checkbox" data-id="${prompt.id}" ${isSelected ? "checked" : ""} />
          <i data-lucide="message-circle" class="icon"></i>
          <span class="badge badge-prompt">${t("badge-prompt")}</span>
          ${isLinked ? `<span class="badge badge-linked"><i data-lucide="link" class="icon-sm"></i> ${t("badge-linked")}</span>` : ""}
          <span class="prompt-date">${promptDate}</span>
        </div>
        <div class="prompt-actions">
          <button class="btn-delete" onclick="deletePromptWithLink('${prompt.id}', ${isLinked})">
            <i data-lucide="trash-2" class="icon"></i>
            ${isLinked ? t("btn-delete-pair") : t("btn-delete")}
          </button>
        </div>
      </div>
      <div class="prompt-content">
        ${escapeHtml(prompt.content)}
      </div>
      ${isLinked ? `<div class="link-indicator"><i data-lucide="arrow-down" class="icon-sm"></i> ${t("text-generated-above")} <i data-lucide="arrow-up" class="icon-sm"></i></div>` : ""}
    </div>
  `;
}

function renderMemoryCard(memory) {
  const isSelected = state.selectedMemories.has(memory.id);
  const isPinned = memory.isPinned || false;
  const isLinked = !!memory.linkedPromptId;
  const similarityHtml =
    memory.similarity !== undefined
      ? `<span class="similarity-score">${memory.similarity}%</span>`
      : "";

  let displayInfo = memory.displayName || memory.id;
  if (memory.projectPath) {
    const pathParts = memory.projectPath
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p);
    displayInfo = pathParts[pathParts.length - 1] || memory.projectPath;
  }

  let subtitle = "";
  if (memory.projectPath) {
    subtitle = `<span class="memory-subtitle">${escapeHtml(memory.projectPath)}</span>`;
  }

  const pinButton = isPinned
    ? `<button class="btn-pin pinned" onclick="unpinMemory('${memory.id}')" title="Unpin"><i data-lucide="pin" class="icon icon-filled"></i></button>`
    : `<button class="btn-pin" onclick="pinMemory('${memory.id}')" title="Pin"><i data-lucide="pin" class="icon"></i></button>`;

  const createdDate = formatDate(memory.createdAt);
  const updatedDate =
    memory.updatedAt && memory.updatedAt !== memory.createdAt ? formatDate(memory.updatedAt) : null;

  const dateInfo = updatedDate
    ? `<span>${t("date-created")} ${createdDate}</span><span>${t("date-updated")} ${updatedDate}</span>`
    : `<span>${t("date-created")} ${createdDate}</span>`;
  const tagsHtml =
    memory.tags && memory.tags.length > 0
      ? `<div class="tags-list">${memory.tags.map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

  return `
    <div class="memory-card ${isSelected ? "selected" : ""} ${isPinned ? "pinned" : ""}" data-id="${memory.id}">
      <div class="memory-header">
        <div class="meta">
          <input type="checkbox" class="memory-checkbox" data-id="${memory.id}" ${isSelected ? "checked" : ""} />
          ${memory.memoryType ? `<span class="badge badge-type">${escapeHtml(memory.memoryType)}</span>` : ""}
          ${isLinked ? `<span class="badge badge-linked"><i data-lucide="link" class="icon-sm"></i> ${t("badge-linked")}</span>` : ""}
          ${similarityHtml}
          ${isPinned ? `<span class="badge badge-pinned">${t("badge-pinned")}</span>` : ""}
          <span class="memory-display-name">${escapeHtml(displayInfo)}</span>
          ${subtitle}
        </div>
        <div class="memory-actions">
          ${pinButton}
          <button class="btn-edit" onclick="editMemory('${memory.id}')"><i data-lucide="edit-3" class="icon"></i></button>
          <button class="btn-delete" onclick="deleteMemoryWithLink('${memory.id}', ${isLinked})">
            <i data-lucide="trash-2" class="icon"></i>
            ${isLinked ? t("btn-delete-pair") : t("btn-delete")}
          </button>
        </div>
      </div>
      ${tagsHtml}
      <div class="memory-content markdown-content">${renderMarkdown(memory.content)}</div>
      ${isLinked ? `<div class="link-indicator"><i data-lucide="arrow-up" class="icon-sm"></i> ${t("text-from-below")} <i data-lucide="arrow-down" class="icon-sm"></i></div>` : ""}
      <div class="memory-footer">
        ${dateInfo}
        <span>ID: ${memory.id}</span>
      </div>
    </div>
  `;
}

function handleCheckboxChange(e) {
  const id = e.target.dataset.id;
  if (e.target.checked) {
    state.selectedMemories.add(id);
  } else {
    state.selectedMemories.delete(id);
  }
  updateBulkActions();
  updateCardSelection(id, e.target.checked);
}

function updateCardSelection(id, selected) {
  const card = document.querySelector(
    `.memory-card[data-id="${id}"], .prompt-card[data-id="${id}"]`
  );
  if (card) {
    if (selected) {
      card.classList.add("selected");
    } else {
      card.classList.remove("selected");
    }
  }
}

function updateBulkActions() {
  const bulkActions = document.getElementById("bulk-actions");
  const selectedCount = document.getElementById("selected-count");

  if (state.selectedMemories.size > 0) {
    bulkActions.classList.remove("hidden");
    selectedCount.textContent = t("text-selected", { count: state.selectedMemories.size });
  } else {
    bulkActions.classList.add("hidden");
  }
}

function updatePagination() {
  const pageInfo = t("text-page", { current: state.currentPage, total: state.totalPages });
  document.getElementById("page-info-top").textContent = pageInfo;
  document.getElementById("page-info-bottom").textContent = pageInfo;
  const hasPrev = state.currentPage > 1;
  const hasNext = state.currentPage < state.totalPages;

  document.getElementById("prev-page-top").disabled = !hasPrev;
  document.getElementById("next-page-top").disabled = !hasNext;
  document.getElementById("prev-page-bottom").disabled = !hasPrev;
  document.getElementById("next-page-bottom").disabled = !hasNext;
}

function updateSectionTitle() {
  const title = state.isSearching
    ? `└─ SEARCH RESULTS (${state.totalItems}) ──`
    : t("section-project", { count: state.totalItems });
  document.getElementById("section-title").textContent = title;
}

async function loadStats() {
  const result = await fetchAPI("/api/stats");
  if (result.success) {
    document.getElementById("stats-total").textContent = t("text-total", {
      count: result.data.total,
    });
  }
}

async function addMemory(e) {
  e.preventDefault();

  const content = document.getElementById("add-content").value.trim();
  const containerTag = document.getElementById("add-tag").value;
  const type = document.getElementById("add-type").value;
  const tagsStr = document.getElementById("add-tags").value.trim();
  const tags = tagsStr
    ? tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t)
    : [];

  if (!content || !containerTag) {
    showToast(t("toast-add-error"), "error");
    return;
  }

  const result = await fetchAPI("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, containerTag, type: type || undefined, tags }),
  });

  if (result.success) {
    showToast(t("toast-add-success"), "success");
    document.getElementById("add-form").reset();
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || t("toast-add-failed"), "error");
  }
}

async function loadMemories() {
  showRefreshIndicator(true);

  let endpoint = `/api/memories?page=${state.currentPage}&pageSize=${state.pageSize}&includePrompts=true`;

  if (state.isSearching) {
    endpoint = `/api/search?q=${encodeURIComponent(state.searchQuery || "")}&page=${state.currentPage}&pageSize=${state.pageSize}`;
    if (state.selectedTag) {
      endpoint += `&tag=${encodeURIComponent(state.selectedTag)}`;
    }
  } else {
    if (state.selectedTag) {
      endpoint += `&tag=${encodeURIComponent(state.selectedTag)}`;
    }
  }

  const result = await fetchAPI(endpoint);

  showRefreshIndicator(false);

  if (result.success) {
    state.memories = result.data.items;
    state.totalPages = result.data.totalPages;
    state.totalItems = result.data.total;
    state.currentPage = result.data.page;

    renderMemories();
    updatePagination();
    updateSectionTitle();
  } else {
    showError(result.error || t("toast-update-failed"));
  }
}

async function deleteMemoryWithLink(id, isLinked) {
  const message = isLinked ? t("confirm-delete-pair") : t("confirm-delete");
  if (!confirm(message)) return;

  const result = await fetchAPI(`/api/memories/${id}?cascade=true`, {
    method: "DELETE",
  });

  if (result.success) {
    showToast(t("toast-delete-success"), "success");

    state.selectedMemories.delete(id);
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || t("toast-delete-failed"), "error");
  }
}

async function deletePromptWithLink(id, isLinked) {
  const message = isLinked ? t("confirm-delete-prompt") : t("confirm-delete");
  if (!confirm(message)) return;

  const result = await fetchAPI(`/api/prompts/${id}?cascade=true`, {
    method: "DELETE",
  });

  if (result.success) {
    showToast(t("toast-delete-success"), "success");

    state.selectedMemories.delete(id);
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || t("toast-delete-failed"), "error");
  }
}

async function bulkDelete() {
  if (state.selectedMemories.size === 0) return;

  const message = t("confirm-bulk-delete", { count: state.selectedMemories.size });
  if (!confirm(message)) return;

  const ids = Array.from(state.selectedMemories);

  const promptIds = ids.filter((id) => id.startsWith("prompt_"));
  const memoryIds = ids.filter((id) => !id.startsWith("prompt_"));

  let deletedCount = 0;

  if (promptIds.length > 0) {
    const result = await fetchAPI("/api/prompts/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: promptIds, cascade: true }),
    });
    if (result.success) deletedCount += result.data.deleted;
  }

  if (memoryIds.length > 0) {
    const result = await fetchAPI("/api/memories/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: memoryIds, cascade: true }),
    });
    if (result.success) deletedCount += result.data.deleted;
  }

  showToast(t("toast-bulk-delete-success"), "success");
  state.selectedMemories.clear();
  await loadMemories();
  await loadStats();
  updateBulkActions();
}

function deselectAll() {
  state.selectedMemories.clear();
  document.querySelectorAll(".memory-checkbox").forEach((cb) => (cb.checked = false));
  document
    .querySelectorAll(".memory-card, .prompt-card")
    .forEach((card) => card.classList.remove("selected"));
  updateBulkActions();
}

function selectAllCurrentPage() {
  const checkboxes = document.querySelectorAll(".memory-checkbox");
  if (checkboxes.length === 0) return;

  checkboxes.forEach((cb) => {
    cb.checked = true;
    if (cb.dataset.id) {
      state.selectedMemories.add(cb.dataset.id);
      updateCardSelection(cb.dataset.id, true);
    }
  });

  updateBulkActions();
}

function editMemory(id) {
  const memory = state.memories.find((m) => m.id === id && m.type === "memory");
  if (!memory) return;

  document.getElementById("edit-id").value = memory.id;
  document.getElementById("edit-content").value = memory.content;

  document.getElementById("edit-modal").classList.remove("hidden");
}

async function saveEdit(e) {
  e.preventDefault();

  const id = document.getElementById("edit-id").value;
  const content = document.getElementById("edit-content").value.trim();

  if (!content) {
    showToast(t("toast-add-error"), "error");
    return;
  }

  const result = await fetchAPI(`/api/memories/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (result.success) {
    showToast(t("toast-update-success"), "success");
    closeModal();
    await loadMemories();
  } else {
    showToast(result.error || t("toast-update-failed"), "error");
  }
}

function closeModal() {
  document.getElementById("edit-modal").classList.add("hidden");
}

function performSearch() {
  const query = document.getElementById("search-input").value.trim();

  if (!query) {
    clearSearch();
    return;
  }

  state.searchQuery = query;
  state.isSearching = true;
  state.currentPage = 1;

  document.getElementById("clear-search-btn").classList.remove("hidden");

  loadMemories();
}

function clearSearch() {
  state.searchQuery = "";
  state.isSearching = false;
  state.currentPage = 1;

  document.getElementById("search-input").value = "";
  document.getElementById("clear-search-btn").classList.add("hidden");

  loadMemories();
}

function changePage(delta) {
  const newPage = state.currentPage + delta;
  if (newPage < 1 || newPage > state.totalPages) return;

  state.currentPage = newPage;
  loadMemories();
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

function showError(message) {
  const container = document.getElementById("memories-list");
  container.innerHTML = `<div class="error-state">Error: ${escapeHtml(message)}</div>`;
}

function showRefreshIndicator(show) {
  const indicator = document.getElementById("refresh-indicator");
  if (show) {
    indicator.classList.remove("hidden");
  } else {
    indicator.classList.add("hidden");
  }
}

function formatDate(isoString) {
  const date = new Date(isoString);
  const lang = getLanguage();
  const locale = lang === "zh" ? "zh-CN" : lang === "ar" ? "ar-SA" : "en-US";
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function pinMemory(id) {
  const result = await fetchAPI(`/api/memories/${id}/pin`, { method: "POST" });

  if (result.success) {
    showToast(t("toast-update-success"), "success");
    await loadMemories();
  } else {
    showToast(result.error || t("toast-update-failed"), "error");
  }
}

async function unpinMemory(id) {
  const result = await fetchAPI(`/api/memories/${id}/unpin`, { method: "POST" });

  if (result.success) {
    showToast(t("toast-update-success"), "success");
    await loadMemories();
  } else {
    showToast(result.error || t("toast-update-failed"), "error");
  }
}

async function runCleanup() {
  if (!confirm(t("confirm-cleanup"))) return;

  showToast(t("status-cleanup"), "info");
  const result = await fetchAPI("/api/cleanup", { method: "POST" });

  if (result.success) {
    showToast(t("toast-cleanup-success"), "success");
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || t("toast-cleanup-failed"), "error");
  }
}

async function runDeduplication() {
  if (!confirm(t("confirm-dedup"))) return;

  showToast(t("status-dedup"), "info");
  const result = await fetchAPI("/api/deduplicate", { method: "POST" });

  if (result.success) {
    showToast(t("toast-dedup-success"), "success");
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || t("toast-dedup-failed"), "error");
  }
}

function startAutoRefresh() {
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
  }

  state.autoRefreshInterval = setInterval(() => {
    loadStats();
    if (!state.isSearching) {
      loadMemories();
    }
  }, 30000);
}

async function checkMigrationStatus() {
  const result = await fetchAPI("/api/migration/detect");
  if (result.success && result.data.needsMigration) {
    showMigrationWarning(result.data);
  }

  const tagResult = await fetchAPI("/api/migration/tags/detect");
  if (tagResult.success && tagResult.data.needsMigration) {
    showTagMigrationModal(tagResult.data.count);
  }
}

function showTagMigrationModal(count) {
  const overlay = document.getElementById("tag-migration-overlay");
  const status = document.getElementById("tag-migration-status");
  status.textContent = t("migration-found-tags", { count });

  document.getElementById("start-tag-migration-btn").onclick = runTagMigration;
}

async function runTagMigration() {
  const actions = document.getElementById("tag-migration-actions");
  const status = document.getElementById("tag-migration-status");
  const progress = document.getElementById("tag-migration-progress");

  actions.classList.add("hidden");
  status.textContent = t("status-migration-init");
  progress.style.width = "0%";

  let totalProcessed = 0;
  let hasMore = true;
  let attempts = 0;
  const maxAttempts = 1000;

  while (hasMore && attempts < maxAttempts) {
    attempts++;
    const result = await fetchAPI("/api/migration/tags/run-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchSize: 3 }),
    });

    if (!result.success) {
      status.textContent = t("toast-migration-failed") + ": " + result.error;
      return;
    }

    totalProcessed = result.data.processed;
    hasMore = result.data.hasMore;
    const total = result.data.total;
    const percent = total > 0 ? Math.round((totalProcessed / total) * 100) : 0;

    progress.style.width = percent + "%";
    status.textContent = t("status-migration-progress", { current: totalProcessed, total: total });
    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (attempts >= maxAttempts) {
    status.textContent = t("migration-stopped");
    return;
  }

  progress.style.width = "100%";
  status.textContent = t("toast-migration-success");
  showToast(t("toast-migration-success"), "success");
  setTimeout(() => {
    document.getElementById("tag-migration-overlay").classList.add("hidden");
    loadMemories();
    loadStats();
  }, 2000);
}

function showMigrationWarning(data) {
  const section = document.getElementById("migration-section");
  const message = document.getElementById("migration-message");

  const shardInfo =
    data.shardMismatches.length > 0
      ? t("migration-shards-mismatch", { count: data.shardMismatches.length })
      : t("migration-dimension-mismatch");

  message.textContent = t("migration-mismatch-details", {
    configDimensions: data.configDimensions,
    configModel: data.configModel,
    shardInfo,
  });

  lucide.createIcons();
}

function toggleMigrationButtons() {
  const checkbox = document.getElementById("migration-confirm-checkbox");
  const freshBtn = document.getElementById("migration-fresh-btn");
  const reembedBtn = document.getElementById("migration-reembed-btn");

  freshBtn.disabled = !checkbox.checked;
  reembedBtn.disabled = !checkbox.checked;
}

async function runMigration(strategy) {
  const checkbox = document.getElementById("migration-confirm-checkbox");

  if (!checkbox.checked) {
    showToast(t("toast-migration-failed"), "error");
    return;
  }

  const strategyName =
    strategy === "fresh-start" ? "Fresh Start (Delete All)" : "Re-embed (Preserve Data)";

  if (
    !confirm(
      `Run ${strategyName} migration?\n\nThis operation is IRREVERSIBLE and will:\n${strategy === "fresh-start" ? "- DELETE all existing memories\n- Remove all shards" : "- Re-embed all memories with new model\n- This may take several minutes"}\n\nContinue?`
    )
  ) {
    return;
  }

  showToast(t("status-migration-init"), "info");
  const result = await fetchAPI("/api/migration/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strategy }),
  });

  if (result.success) {
    const data = result.data;
    let message = `Migration complete! `;

    if (strategy === "fresh-start") {
      message += `Deleted ${data.deletedShards} shard(s). Duration: ${(data.duration / 1000).toFixed(2)}s`;
    } else {
      message += `Re-embedded ${data.reEmbeddedMemories} memories. Duration: ${(data.duration / 1000).toFixed(2)}s`;
    }

    showToast(t("toast-migration-success"), "success");
    document.getElementById("migration-section").classList.add("hidden");
    document.getElementById("migration-confirm-checkbox").checked = false;

    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || t("toast-migration-failed"), "error");
  }
}

async function loadUserProfile() {
  const result = await fetchAPI("/api/user-profile");
  if (result.success) {
    state.userProfile = result.data;
    renderUserProfile();
  } else {
    showError(result.error || t("toast-update-failed"));
  }
}

function renderUserProfile() {
  const container = document.getElementById("profile-content");
  const profile = state.userProfile;

  if (!profile.exists) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="user-x" class="icon-large"></i>
        <p>${profile.message}</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  let data = profile.profileData;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      console.error("Failed to parse profileData string", e);
    }
  }

  const parseField = (field) => {
    if (!field) return [];
    let result = field;
    let lastResult = null;
    while (typeof result === "string" && result !== lastResult) {
      lastResult = result;
      try {
        result = JSON.parse(typeof jsonrepair === "function" ? jsonrepair(result) : result);
      } catch {
        break;
      }
    }
    if (!Array.isArray(result)) return [];
    const flattened = [];
    const walk = (item) => {
      if (Array.isArray(item)) item.forEach(walk);
      else if (item && typeof item === "object") flattened.push(item);
    };
    walk(result);
    return flattened;
  };

  const PAGE_SIZE = 20;
  function paginate(items, page, type) {
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = items.slice(start, start + PAGE_SIZE);
    if (total <= PAGE_SIZE) return { items: pageItems, controls: "" };
    if (page > totalPages) page = totalPages;
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(
        `<button class="btn-page${i === page ? " active" : ""}" data-page-type="${type}" data-page="${i}">${i}</button>`
      );
    }
    const controls = `
        <div class="pagination-bar">
          <span class="pagination-info">${start + 1}-${Math.min(start + PAGE_SIZE, total)} / ${total}</span>
          ${pages.join("")}
        </div>`;
    return { items: pageItems, controls };
  }

  const preferences = parseField(data.preferences);
  const patterns = parseField(data.patterns);
  const workflows = parseField(data.workflows);

  if (!state.profilePages) {
    state.profilePages = { pref: 1, pat: 1, wf: 1 };
  }
  const pp = paginate(preferences, state.profilePages.pref, "pref");
  const pt = paginate(patterns, state.profilePages.pat, "pat");
  const pw = paginate(workflows, state.profilePages.wf, "wf");

  container.innerHTML = `
    <div class="profile-header">
      <div class="profile-info">
        <h3>${profile.displayName || profile.userId}</h3>
        <div class="profile-stats">
          <div class="stat-pill">
            <span class="label">${t("profile-version")}</span>
            <span class="value">${profile.version}</span>
          </div>
          <div class="stat-pill">
            <span class="label">${t("profile-prompts")}</span>
            <span class="value">${profile.totalPromptsAnalyzed}</span>
          </div>
          <div class="stat-pill">
            <span class="label">${t("profile-updated")}</span>
            <span class="value">${formatDate(profile.lastAnalyzedAt)}</span>
          </div>
        </div>
      </div>
      <button id="view-changelog-btn" class="btn-secondary compact">
        <i data-lucide="history" class="icon"></i> History
      </button>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-section preferences-section">
        <h4><i data-lucide="heart" class="icon"></i> ${t("profile-preferences")} <span class="count">${preferences.length}</span></h4>
        ${
          preferences.length === 0
            ? `<p class="empty-text">${t("empty-preferences")}</p>`
            : `
          <div class="cards-grid">
            ${pp.items
              .map(
                (p) => `
              <div class="compact-card preference-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(p.category || "General")}</span>
                  <div class="card-actions">
                    <button class="btn-icon btn-edit-profile-item" data-type="preferences" data-index="${preferences.indexOf(p)}" title="${t("btn-edit") || "Edit"}"><i data-lucide="pencil" class="icon-xs"></i></button>
                    <button class="btn-icon btn-delete-profile-item" data-type="preferences" data-index="${preferences.indexOf(p)}" title="${t("btn-delete") || "Delete"}"><i data-lucide="trash-2" class="icon-xs"></i></button>
                  </div>
                  <div class="confidence-ring" style="--p:${Math.round((p.confidence || 0) * 1000) / 10}">
                    <span>${Math.round((p.confidence || 0) * 1000) / 10}%</span>
                  </div>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(p.description || "")}</p>
                </div>
                  ${
                    p.evidence || p.frequency
                      ? `
                <div class="card-footer">
                  <span class="evidence-count" title="${t("label-evidence-tooltip", { count: p.frequency || 1 })}">🎯 ${p.frequency || 1}</span>
                  ${
                    p.evidence && p.evidence.length > 0
                      ? `
                  <span class="evidence-sep">·</span>
                  <span class="evidence-toggle" title="${escapeHtml(Array.isArray(p.evidence) ? p.evidence.join("\n") : p.evidence)}">
                    <i data-lucide="info" class="icon-xs"></i> ${Array.isArray(p.evidence) ? p.evidence.length : 1} evidence
                  </span>`
                      : ""
                  }
                </div>`
                      : ""
                  }
              </div>
            `
              )
              .join("")}
          </div>
          ${pp.controls}
        `
        }
      </div>

      <div class="dashboard-section patterns-section">
        <h4><i data-lucide="activity" class="icon"></i> ${t("profile-patterns")} <span class="count">${patterns.length}</span></h4>
        ${
          patterns.length === 0
            ? `<p class="empty-text">${t("empty-patterns")}</p>`
            : `
          <div class="cards-grid">
            ${pt.items
              .map(
                (p) => `
              <div class="compact-card pattern-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(p.category || "General")}</span>
                  <div class="card-actions">
                    <button class="btn-icon btn-edit-profile-item" data-type="patterns" data-index="${patterns.indexOf(p)}" title="${t("btn-edit") || "Edit"}"><i data-lucide="pencil" class="icon-xs"></i></button>
                    <button class="btn-icon btn-delete-profile-item" data-type="patterns" data-index="${patterns.indexOf(p)}" title="${t("btn-delete") || "Delete"}"><i data-lucide="trash-2" class="icon-xs"></i></button>
                  </div>
                  <div class="confidence-ring" style="--p:${Math.round((p.confidence || 0) * 1000) / 10}">
                    <span>${Math.round((p.confidence || 0) * 1000) / 10}%</span>
                  </div>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(p.description || "")}</p>
                </div>
                <div class="card-footer">
                  <span class="evidence-count" title="${t("label-evidence-tooltip", { count: p.frequency || 1 })}">🎯 ${p.frequency || 1}</span>
                  ${
                    p.evidence && p.evidence.length > 0
                      ? `
                  <span class="evidence-sep">·</span>
                  <span class="evidence-toggle" title="${escapeHtml(Array.isArray(p.evidence) ? p.evidence.join("\n") : p.evidence)}">
                    <i data-lucide="info" class="icon-xs"></i> ${Array.isArray(p.evidence) ? p.evidence.length : 1} evidence
                  </span>`
                      : ""
                  }
                </div>
              </div>
            `
              )
              .join("")}
          </div>
          ${pt.controls}
        `
        }
      </div>

      <div class="dashboard-section workflows-section full-width">
        <h4><i data-lucide="workflow" class="icon"></i> ${t("profile-workflows")} <span class="count">${workflows.length}</span></h4>
        ${
          workflows.length === 0
            ? `<p class="empty-text">${t("empty-workflows")}</p>`
            : `
          <div class="workflows-grid">
            ${pw.items
              .sort((a, b) => (b.frequency || 0) - (a.frequency || 0))
              .map(
                (w) => `
              <div class="workflow-row">
                <div class="workflow-header">
                  <div class="workflow-title">${escapeHtml(w.description || "")}</div>
                  <div class="card-actions">
                    <button class="btn-icon btn-edit-profile-item" data-type="workflows" data-index="${workflows.indexOf(w)}" title="${t("btn-edit") || "Edit"}"><i data-lucide="pencil" class="icon-xs"></i></button>
                    <button class="btn-icon btn-delete-profile-item" data-type="workflows" data-index="${workflows.indexOf(w)}" title="${t("btn-delete") || "Delete"}"><i data-lucide="trash-2" class="icon-xs"></i></button>
                  </div>
                  <div class="confidence-ring" style="--p:${Math.round((w.confidence || 0) * 1000) / 10}">
                    <span>${Math.round((w.confidence || 0) * 1000) / 10}%</span>
                  </div>
                </div>
                <div class="workflow-steps-horizontal">
                  ${(w.steps || [])
                    .map(
                      (step, i) => `
                    <div class="step-node">
                      <span class="step-idx">${i + 1}</span>
                      <span class="step-content">${escapeHtml(step)}</span>
                    </div>
                    ${i < (w.steps || []).length - 1 ? '<i data-lucide="arrow-right" class="step-arrow"></i>' : ""}
                  `
                    )
                    .join("")}
                </div>
                <div class="workflow-footer">
                  <span class="evidence-count" title="${t("label-evidence-tooltip", { count: w.frequency || 1 })}">🎯 ${w.frequency || 1}</span>
                  ${
                    w.evidence && w.evidence.length > 0
                      ? `
                  <span class="evidence-sep">·</span>
                  <span class="evidence-toggle" title="${escapeHtml(Array.isArray(w.evidence) ? w.evidence.join("\n") : w.evidence)}">
                    <i data-lucide="info" class="icon-xs"></i> ${Array.isArray(w.evidence) ? w.evidence.length : 1} evidence
                  </span>`
                      : ""
                  }
                </div>
              </div>
            `
              )
              .join("")}
          </div>
          ${pw.controls}
        `
        }
      </div>
    </div>
  `;

  document.getElementById("view-changelog-btn")?.addEventListener("click", showChangelog);
  lucide.createIcons();
}

async function showChangelog() {
  const modal = document.getElementById("changelog-modal");
  const list = document.getElementById("changelog-list");

  modal.classList.remove("hidden");
  list.innerHTML = `<div class="loading">${t("loading-changelog")}</div>`;
  const result = await fetchAPI(
    `/api/user-profile/changelog?profileId=${state.userProfile.id}&limit=10`
  );

  if (result.success && result.data.length > 0) {
    list.innerHTML = result.data
      .map(
        (c) => `
      <div class="changelog-item">
        <div class="changelog-header">
          <span class="changelog-version">v${c.version}</span>
          <span class="changelog-type">${c.changeType}</span>
          <span class="changelog-date">${formatDate(c.createdAt)}</span>
        </div>
        <p class="changelog-summary">${escapeHtml(c.changeSummary)}</p>
      </div>
    `
      )
      .join("");
  } else {
    list.innerHTML = `<div class="empty-state">${t("empty-changelog")}</div>`;
  }
}

async function refreshProfile() {
  showToast(t("loading-profile"), "info");
  const result = await fetchAPI("/api/user-profile/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (result.success) {
    showToast(result.data.message, "success");
    await loadUserProfile();
  } else {
    showToast(result.error || t("toast-update-failed"), "error");
  }
}
async function showAICleanup() {
  const modal = document.getElementById("ai-cleanup-modal");
  const loading = document.getElementById("cleanup-loading");
  const diffV2 = document.getElementById("cleanup-diff-v2");
  const applyBtn = document.getElementById("cleanup-apply-btn");
  const sections = document.getElementById("cleanup-sections");

  modal.classList.remove("hidden");
  loading.classList.add("hidden");
  diffV2.classList.remove("hidden");
  diffV2.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;";
  applyBtn.classList.add("hidden");
  document.getElementById("cleanup-toolbar")?.classList.add("hidden");
  document.getElementById("cleanup-kept-section")?.classList.add("hidden");

  if (!state.userProfile?.profileData) {
    showToast("No profile data loaded", "error");
    modal.classList.add("hidden");
    return;
  }

  const pd = state.userProfile.profileData;
  const allItems = [
    ...(pd.preferences || []).map((p, i) => ({ ...p, _id: `pref_${i}`, _type: "pref" })),
    ...(pd.patterns || []).map((p, i) => ({ ...p, _id: `pat_${i}`, _type: "pat" })),
    ...(pd.workflows || []).map((w, i) => ({ ...w, _id: `wf_${i}`, _type: "wf" })),
  ];

  let html = `<div class="cleanup-select-header">
    <h3>${t("label-ai-cleanup-select")}</h3>
    <div class="cleanup-select-actions">
      <button class="btn btn-secondary" id="sel-all">${t("label-ai-cleanup-select-all")}</button>
      <button class="btn btn-secondary" id="sel-none">${t("label-ai-cleanup-deselect-all")}</button>
      <button class="btn btn-secondary" id="sel-low">${t("label-ai-cleanup-select-low")}</button>
      <button class="btn btn-secondary" id="sel-same-cat">${t("label-ai-cleanup-select-same-cat")}</button>
    </div>
  </div>`;

  const cats = {};
  for (const it of allItems) {
    const cat = it.category || "(none)";
    if (!cats[cat]) cats[cat] = { pref: [], pat: [], wf: [] };
    cats[cat][it._type === "wf" ? "wf" : it._type === "pat" ? "pat" : "pref"].push(it);
  }

  html += `<div class="cleanup-select-grid">`;
  for (const cat of Object.keys(cats).sort()) {
    const items = [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf];
    html += `<div class="cleanup-cat-group">
      <div class="cleanup-cat-header">
        <span class="category-tag">${escapeHtml(cat)}</span>
        <span class="cat-count">${items.length} items</span>
      </div>`;
    for (const it of items) {
      const freq = it.frequency || 0;
      const conf = it.confidence;
      html += `<label class="cleanup-item-row">
        <input type="checkbox" class="cleanup-sel-item" data-id="${it._id}" ${freq <= 3 ? "checked" : ""}>
        <span class="cleanup-item-type">${it._type === "pref" ? "P" : it._type === "pat" ? "T" : "W"}</span>
        <span class="cleanup-item-desc">${escapeHtml((it.description || "").substring(0, 80))}</span>
        <span class="cleanup-item-stats">🎯${freq}${conf != null ? " | " + Math.round(conf * 100) + "%" : ""}</span>
      </label>`;
    }
    html += `</div>`;
  }
  html += `</div>
  <div class="cleanup-select-footer">
    <span id="cleanup-sel-count">${t("label-ai-cleanup-selected", { count: allItems.filter((it) => (it.frequency || 0) <= 3).length })}</span>
    <button class="btn btn-primary" id="sel-analyze">${t("label-ai-cleanup-analyze")}</button>
  </div>`;

  sections.innerHTML = html;

  const getSelected = () =>
    [...document.querySelectorAll(".cleanup-sel-item:checked")].map((cb) => cb.dataset.id);

  const updateCount = () => {
    document.getElementById("cleanup-sel-count").textContent = t("label-ai-cleanup-selected", {
      count: getSelected().length,
    });
  };

  sections.addEventListener("change", (e) => {
    if (e.target.classList.contains("cleanup-sel-item")) updateCount();
  });

  document.getElementById("sel-all").addEventListener("click", () => {
    document.querySelectorAll(".cleanup-sel-item").forEach((cb) => {
      cb.checked = true;
    });
    updateCount();
  });
  document.getElementById("sel-none").addEventListener("click", () => {
    document.querySelectorAll(".cleanup-sel-item").forEach((cb) => {
      cb.checked = false;
    });
    updateCount();
  });
  document.getElementById("sel-low").addEventListener("click", () => {
    document.querySelectorAll(".cleanup-sel-item").forEach((cb) => {
      const it = allItems.find((x) => x._id === cb.dataset.id);
      cb.checked = it && (it.frequency || 0) <= 3;
    });
    updateCount();
  });
  document.getElementById("sel-same-cat").addEventListener("click", () => {
    document.querySelectorAll(".cleanup-sel-item").forEach((cb) => {
      cb.checked = false;
    });
    // Select items from categories with 3+ items
    for (const cat of Object.keys(cats)) {
      const count = [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf].length;
      if (count >= 3) {
        [...cats[cat].pref, ...cats[cat].pat, ...cats[cat].wf].forEach((it) => {
          const cb = document.querySelector(`.cleanup-sel-item[data-id="${it._id}"]`);
          if (cb) cb.checked = true;
        });
      }
    }
    updateCount();
  });

  document.getElementById("sel-analyze").addEventListener("click", async () => {
    const ids = getSelected();
    if (ids.length === 0) {
      showToast("No items selected", "warn");
      return;
    }
    sections.innerHTML = "";
    loading.classList.remove("hidden");
    try {
      const result = await fetchAPI("/api/user-profile/ai-cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeIds: ids }),
        timeout: 180000,
      });
      loading.classList.add("hidden");
      if (!result.success) {
        showToast(result.error || "Cleanup failed", "error");
        return;
      }
      renderCleanupDiffV2(result.data);
      diffV2.classList.remove("hidden");
      state.pendingCleanup = result.data;
    } catch (e) {
      loading.classList.add("hidden");
      showToast("Cleanup failed: " + e.message, "error");
    }
  });

  setTimeout(() => applyLanguage?.(), 0);
  lucide?.createIcons?.();
}

function renderCleanupDiffV2(data) {
  const changes = data.changes;
  const sections = document.getElementById("cleanup-sections");
  const diffV2 = document.getElementById("cleanup-diff-v2");
  diffV2.style.cssText = "";
  sections.style.cssText = "";

  let html = renderMergeSection(changes.merged || [], data.old);
  html += renderRemoveSection(changes.removed || [], data.old);
  sections.innerHTML = html;

  renderKeptSection(changes.kept || []);
  bindCleanupToolbar();

  const applyBtn = document.getElementById("cleanup-apply-btn");
  applyBtn.classList.remove("hidden");
  applyBtn.textContent = t("label-ai-cleanup-apply") || "Apply Changes";

  setTimeout(() => applyLanguage?.(), 0);
  lucide?.createIcons?.();
}

function renderMergeSection(merged, old) {
  if (merged.length === 0) return "";

  let html = `<h4 class="section-divider"><i data-lucide="git-merge" class="icon-xs"></i> ${t("label-ai-cleanup-merged-header", { count: merged.length })}</h4>`;

  merged.forEach((m, mi) => {
    const mainId = m.ids[0];
    const mergedFrom = m.ids.slice(1);
    const mainDesc = m.result || "";
    const mainSteps = findStepsById(mainId, old);
    const mergedDescs = mergedFrom
      .map((id) => {
        const desc = findDescById(id, old);
        const typeLabel = getTypeLabel(id);
        const steps = findStepsById(id, old);
        return desc ? { desc, typeLabel, steps } : null;
      })
      .filter(Boolean);

    const stepsAfter = mainSteps?.length
      ? `<div class="cleanup-steps">${renderStepsInline(mainSteps)}</div>`
      : "";

    html += `<div class="diff-card merge-card" data-group="${mi}">
        <label class="diff-card-check">
          <input type="checkbox" class="diff-checkbox" data-type="merged" data-index="${mi}" checked>
          <span class="check-label">${t("label-ai-cleanup-merge-check")}</span>
        </label>
        <div class="merge-body">
          <div class="merge-before">
            ${mergedDescs
              .map((d) => {
                const stepsHtml = d.steps?.length
                  ? `<div class="cleanup-steps">${renderStepsInline(d.steps)}</div>`
                  : "";
                return `<div class="merge-source"><span class="type-badge">${d.typeLabel}</span> ${escapeHtml(d.desc.substring(0, 80))}${d.desc.length > 80 ? "..." : ""}${stepsHtml}</div>`;
              })
              .join("")}
          </div>
          <div class="merge-arrow">▶</div>
          <div class="merge-after">${escapeHtml(mainDesc.substring(0, 120))}${mainDesc.length > 120 ? "..." : ""}${stepsAfter}</div>
        </div>
      </div>`;
  });

  return html;
}

function renderRemoveSection(removed, old) {
  if (removed.length === 0) return "";

  let html = `<h4 class="section-divider"><i data-lucide="trash-2" class="icon-xs"></i> ${t("label-ai-cleanup-removed-header", { count: removed.length })}</h4>`;

  removed.forEach((r, ri) => {
    const desc = findDescById(r.id, old);
    const steps = findStepsById(r.id, old);
    const stepsHtml = steps?.length
      ? `<div class="cleanup-steps">${renderStepsInline(steps)}</div>`
      : "";
    html += `<div class="diff-card remove-card" data-group="${ri}">
        <label class="diff-card-check">
          <input type="checkbox" class="diff-checkbox" data-type="removed" data-index="${ri}" checked>
          <span class="check-label">${t("label-ai-cleanup-remove-check")}</span>
        </label>
        <div class="remove-body">
          <div class="remove-desc">${escapeHtml(desc || r.id)}${stepsHtml}</div>
          <div class="remove-reason">${escapeHtml(r.reason)}</div>
        </div>
      </div>`;
  });

  return html;
}

function renderKeptSection(kept) {
  const keptCount = document.getElementById("cleanup-kept-count");
  const keptList = document.getElementById("cleanup-kept-list");
  const keptItems = kept || [];

  keptCount.textContent = `(${keptItems.length})`;
  keptList.innerHTML = keptItems
    .map((k) => `<div class="kept-item">${escapeHtml(k)}</div>`)
    .join("");

  if (keptItems.length === 0) {
    document.getElementById("cleanup-kept-section").classList.add("hidden");
  } else {
    document.getElementById("cleanup-kept-section").classList.remove("hidden");
    keptList.classList.add("hidden");
  }

  document.getElementById("cleanup-kept-toggle").onclick = () => {
    keptList.classList.toggle("hidden");
    const icon = document.getElementById("cleanup-kept-toggle").querySelector("i");
    if (icon) {
      icon.setAttribute(
        "data-lucide",
        keptList.classList.contains("hidden") ? "chevron-down" : "chevron-up"
      );
    }
    lucide?.createIcons?.();
  };
}

function bindCleanupToolbar() {
  document.querySelectorAll(".diff-checkbox").forEach((cb) => {
    cb.addEventListener("change", updateCleanupStats);
  });

  updateCleanupStats();

  document.getElementById("cleanup-select-all").onclick = () => {
    document.querySelectorAll(".diff-checkbox").forEach((cb) => {
      cb.checked = true;
    });
    updateCleanupStats();
  };
  document.getElementById("cleanup-deselect-all").onclick = () => {
    document.querySelectorAll(".diff-checkbox").forEach((cb) => {
      cb.checked = false;
    });
    updateCleanupStats();
  };
}

function getTypeLabel(id) {
  if (typeof id !== "string" || !id.includes("_")) return "?";
  const prefix = id.split("_")[0];
  if (prefix === "pref") return t("profile-type-pref") || "Pref";
  if (prefix === "pat") return t("profile-type-pat") || "Pat";
  if (prefix === "wf") return t("profile-type-wf") || "Wf";
  return "?";
}

function findDescById(id, profileData) {
  if (!profileData) return null;
  if (typeof id === "string" && id.includes("_")) {
    const parts = id.split("_");
    const prefix = parts[0];
    const idx = parseInt(parts[1], 10);
    if (!isNaN(idx)) {
      if (prefix === "pref" && profileData.preferences?.[idx]) {
        return profileData.preferences[idx].description;
      }
      if (prefix === "pat" && profileData.patterns?.[idx]) {
        return profileData.patterns[idx].description;
      }
      if (prefix === "wf" && profileData.workflows?.[idx]) {
        return profileData.workflows[idx].description;
      }
    }
  }
  return null;
}

function findStepsById(id, profileData) {
  if (!profileData || typeof id !== "string" || !id.includes("_")) return null;
  const parts = id.split("_");
  const idx = parseInt(parts[1], 10);
  if (isNaN(idx) || parts[0] !== "wf") return null;
  return profileData.workflows?.[idx]?.steps || null;
}

function renderStepsInline(steps) {
  return steps
    .map(
      (s, i) =>
        `<span class="step-inline"><span class="step-inline-num">${i + 1}</span> ${escapeHtml(s)}</span>`
    )
    .join('<span class="step-arrow-inline">→</span>');
}

function updateCleanupStats() {
  const checkboxes = document.querySelectorAll(".diff-checkbox");
  let selected = 0;
  checkboxes.forEach((cb) => {
    if (cb.checked) selected++;
  });
  const total = checkboxes.length;
  document.getElementById("cleanup-stats").textContent = t("label-ai-cleanup-changes-selected", {
    selected,
    total,
  });
  const btn = document.getElementById("cleanup-apply-btn");
  if (btn) {
    btn.textContent =
      selected > 0
        ? `${t("label-ai-cleanup-apply")} (${selected})`
        : t("label-ai-cleanup-apply") || "Apply";
    btn.disabled = selected === 0;
  }
}

async function applyAICleanup() {
  const applyBtn = document.getElementById("cleanup-apply-btn");
  applyBtn.disabled = true;

  const acceptedMerged = [];
  const acceptedRemoved = [];
  document.querySelectorAll(".diff-checkbox").forEach((cb) => {
    if (!cb.checked) return;
    if (cb.dataset.type === "merged") {
      const mi = parseInt(cb.dataset.index, 10);
      const change = state.pendingCleanup?.changes?.merged?.[mi];
      if (change) acceptedMerged.push(change.ids);
    } else if (cb.dataset.type === "removed") {
      const ri = parseInt(cb.dataset.index, 10);
      const change = state.pendingCleanup?.changes?.removed?.[ri];
      if (change) acceptedRemoved.push(change.id);
    }
  });

  try {
    const result = await fetchAPI("/api/user-profile/ai-cleanup/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: state.pendingCleanup?.new,
        acceptedMerged,
        acceptedRemoved,
      }),
    });

    if (result.success) {
      showToast(t("toast-cleanup-success"), "success");
      closeCleanupModal();
      delete state.pendingCleanup;
      await loadUserProfile();
    } else {
      showToast(result.error || t("toast-cleanup-apply-failed"), "error");
    }
  } catch (e) {
    showToast(t("toast-cleanup-apply-failed") + ": " + e.message, "error");
  }

  applyBtn.disabled = false;
}

function closeCleanupModal() {
  document.getElementById("ai-cleanup-modal").classList.add("hidden");
  delete state.pendingCleanup;
}

function showProfileItemModal(type, index, action) {
  const current = getCurrentItem(type, index);
  if (!current) return;

  const isEdit = action === "edit";
  const isWorkflow = type === "workflows";
  const modal = document.getElementById("profile-item-modal");

  document.getElementById("profile-item-modal-title").textContent = isEdit
    ? t("btn-edit") || "Edit Item"
    : t("confirm-delete") || "Delete Item?";
  document.getElementById("profile-item-category").value = current.category || "";
  document.getElementById("profile-item-category").disabled = !isEdit;
  document.getElementById("profile-item-description").value = current.description || "";
  document.getElementById("profile-item-description").disabled = !isEdit;
  document.getElementById("profile-item-category").closest(".form-group").style.display = isWorkflow
    ? "none"
    : "block";
  document.getElementById("profile-item-save").textContent = isEdit
    ? t("btn-save") || "Save"
    : t("btn-delete") || "Delete";

  const stepsSection = document.getElementById("steps-section");
  if (isWorkflow && isEdit) {
    stepsSection.style.display = "block";
    renderStepsEditor(current.steps || []);
  } else {
    stepsSection.style.display = "none";
  }

  const saveBtn = document.getElementById("profile-item-save");
  if (isEdit) saveBtn.classList.remove("danger");
  else saveBtn.classList.add("danger");

  modal.dataset.deleteStep = "1";
  modal.classList.remove("hidden");
  modal._profileAction = { type, index, action };
}

async function editProfileItem(type, index) {
  showProfileItemModal(type, index, "edit");
}

async function deleteProfileItem(type, index) {
  showProfileItemModal(type, index, "delete");
}

function submitProfileItemForm(e) {
  e.preventDefault();
  const modal = document.getElementById("profile-item-modal");
  const { type, index, action } = modal._profileAction || {};
  if (!type) return;

  if (action === "edit") {
    submitProfileEdit(type, index);
  } else if (action === "delete") {
    if (modal.dataset.deleteStep === "2") {
      submitProfileDelete(type, index);
    } else {
      showDeleteConfirmation();
    }
  }
}

async function submitProfileEdit(type, index) {
  const isWorkflow = type === "workflows";
  const category = isWorkflow ? undefined : document.getElementById("profile-item-category").value;
  const description = document.getElementById("profile-item-description").value;
  const body = { type, index, action: "edit", category, description };

  if (type === "workflows") {
    body.steps = collectSteps();
  }

  const result = await fetchAPI("/api/user-profile/item", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (result.success) {
    showToast(t("toast-update-success") || "Item updated", "success");
    closeProfileItemModal();
    await loadUserProfile();
  } else {
    showToast(result.error || t("toast-update-failed") || "Update failed", "error");
  }
}

function showDeleteConfirmation() {
  document.getElementById("profile-item-modal-title").textContent =
    t("confirm-delete-title") || "Confirm Delete";
  document.getElementById("profile-item-category").closest(".form-group").style.display = "none";
  document.getElementById("profile-item-description").closest(".form-group").style.display = "none";
  document.getElementById("profile-item-save").textContent = t("btn-delete") || "Delete";
  document.getElementById("profile-item-save").classList.add("danger");
  document.getElementById("profile-item-modal").dataset.deleteStep = "2";
}

async function submitProfileDelete(type, index) {
  const result = await fetchAPI("/api/user-profile/item", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, index, action: "delete" }),
  });

  if (result.success) {
    showToast(t("toast-delete-success") || "Item deleted", "success");
    closeProfileItemModal();
    await loadUserProfile();
  } else {
    showToast(result.error || t("toast-delete-failed") || "Delete failed", "error");
  }
}

function closeProfileItemModal() {
  const modal = document.getElementById("profile-item-modal");
  modal.classList.add("hidden");
  document.getElementById("profile-item-category").disabled = false;
  document.getElementById("profile-item-category").closest(".form-group").style.display = "block";
  document.getElementById("profile-item-description").disabled = false;
  document.getElementById("profile-item-description").closest(".form-group").style.display =
    "block";
  document.getElementById("steps-section").style.display = "none";
  const saveBtn = document.getElementById("profile-item-save");
  saveBtn.classList.remove("danger");
  modal.dataset.deleteStep = "1";
  delete modal._profileAction;
}

function getCurrentItem(type, index) {
  if (!state.userProfile?.profileData) return null;
  return state.userProfile.profileData[type]?.[index] || null;
}

function renderStepsEditor(steps) {
  const container = document.getElementById("steps-container");
  container.innerHTML = "";
  (steps || []).forEach((step, i) => addStepRow(step, i));
  if (!steps?.length) addStepRow("");
}

function addStepRow(text = "") {
  const container = document.getElementById("steps-container");
  const i = container.children.length;
  const row = document.createElement("div");
  row.className = "step-row";
  row.innerHTML = `<span class="step-num">${i + 1}</span>
    <input type="text" class="step-input" value="${escapeHtml(text)}" placeholder="Step ${i + 1}..." />
    <button type="button" class="btn-icon btn-remove-step" title="${t("btn-delete") || "Delete"}">×</button>`;
  row.querySelector(".btn-remove-step").addEventListener("click", () => removeStepRow(row));
  container.appendChild(row);
}

function removeStepRow(row) {
  row.remove();
  updateStepNumbers();
}

function updateStepNumbers() {
  const rows = document.querySelectorAll("#steps-container .step-row");
  rows.forEach((row, i) => {
    row.querySelector(".step-num").textContent = i + 1;
    row.querySelector(".step-input").placeholder = `Step ${i + 1}...`;
  });
}

function collectSteps() {
  return [...document.querySelectorAll("#steps-container .step-input")]
    .map((el) => el.value.trim())
    .filter(Boolean);
}

function switchView(view) {
  state.currentView = view;

  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));

  if (view === "project") {
    document.getElementById("tab-project").classList.add("active");
    document.getElementById("project-section").classList.remove("hidden");
    document.getElementById("profile-section").classList.add("hidden");
    document.querySelector(".controls").classList.remove("hidden");
    document.querySelector(".add-section").classList.remove("hidden");
  } else if (view === "profile") {
    document.getElementById("tab-profile").classList.add("active");
    document.getElementById("project-section").classList.add("hidden");
    document.getElementById("profile-section").classList.remove("hidden");
    document.querySelector(".controls").classList.add("hidden");
    document.querySelector(".add-section").classList.add("hidden");
    loadUserProfile();
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHostname(hostname) {
  if (!hostname) return false;
  if (LOOPBACK_HOSTS.has(hostname.toLowerCase())) return true;
  // IPv4-mapped IPv6 loopback (e.g. "::ffff:127.0.0.1") and friends.
  if (hostname.startsWith("::ffff:")) {
    return isLoopbackHostname(hostname.slice(7));
  }
  return false;
}

async function checkAuthWarning() {
  const banner = document.getElementById("auth-warning");
  if (!banner) return;

  // Trust the server's report of auth state over guessing from a possibly
  // proxied Host header. The /api/health endpoint is intentionally
  // unauthenticated and exempt from CORS so this fetch is always cheap.
  let authEnabled = false;
  try {
    const response = await fetch("/api/health", { credentials: "same-origin" });
    if (response.ok) {
      const data = await response.json();
      authEnabled = data && data.authEnabled === true;
    }
  } catch (error) {
    // If the probe fails the warning is moot — the UI is unusable anyway.
    return;
  }

  if (authEnabled) {
    banner.classList.add("hidden");
    return;
  }

  if (isLoopbackHostname(window.location.hostname)) {
    banner.classList.add("hidden");
    return;
  }

  banner.classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("tab-project").addEventListener("click", () => switchView("project"));
  document.getElementById("tab-profile").addEventListener("click", () => switchView("profile"));
  document.getElementById("refresh-profile-btn")?.addEventListener("click", refreshProfile);
  document.getElementById("changelog-close")?.addEventListener("click", () => {
    document.getElementById("changelog-modal").classList.add("hidden");
  });

  document.getElementById("lang-toggle").addEventListener("click", () => {
    const langCycle = ["en", "zh", "ar"];
    const currentLang = getLanguage();
    const currentIndex = langCycle.indexOf(currentLang);
    const newLang = langCycle[(currentIndex + 1) % langCycle.length];
    setLanguage(newLang);
    document.getElementById("lang-toggle").textContent = newLang.toUpperCase();
    loadMemories();
    loadStats();
    if (state.currentView === "profile") loadUserProfile();
  });

  document.getElementById("lang-toggle").textContent = getLanguage().toUpperCase();
  setLanguage(getLanguage());

  document.getElementById("tag-filter").addEventListener("change", () => {
    state.selectedTag = document.getElementById("tag-filter").value;
    state.currentPage = 1;
    state.isSearching = false;
    state.searchQuery = "";
    document.getElementById("search-input").value = "";
    document.getElementById("clear-search-btn").classList.add("hidden");
    loadMemories();
  });

  document.getElementById("search-btn").addEventListener("click", performSearch);
  document.getElementById("clear-search-btn").addEventListener("click", clearSearch);
  document.getElementById("search-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") performSearch();
  });

  document.getElementById("add-form").addEventListener("submit", addMemory);
  document.getElementById("edit-form").addEventListener("submit", saveEdit);
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("cancel-edit").addEventListener("click", closeModal);

  document.getElementById("prev-page-top").addEventListener("click", () => changePage(-1));
  document.getElementById("next-page-top").addEventListener("click", () => changePage(1));
  document.getElementById("prev-page-bottom").addEventListener("click", () => changePage(-1));
  document.getElementById("next-page-bottom").addEventListener("click", () => changePage(1));

  document.getElementById("bulk-delete-btn").addEventListener("click", bulkDelete);
  document.getElementById("select-all-btn").addEventListener("click", selectAllCurrentPage);
  document.getElementById("deselect-all-btn").addEventListener("click", deselectAll);

  document.getElementById("cleanup-btn").addEventListener("click", runCleanup);
  document.getElementById("deduplicate-btn").addEventListener("click", runDeduplication);

  document
    .getElementById("migration-confirm-checkbox")
    .addEventListener("change", toggleMigrationButtons);
  document
    .getElementById("migration-fresh-btn")
    .addEventListener("click", () => runMigration("fresh-start"));
  document
    .getElementById("migration-reembed-btn")
    .addEventListener("click", () => runMigration("re-embed"));

  document.getElementById("edit-modal").addEventListener("click", (e) => {
    if (e.target.id === "edit-modal") closeModal();
  });

  document.getElementById("ai-cleanup-btn")?.addEventListener("click", showAICleanup);
  document.getElementById("cleanup-modal-close")?.addEventListener("click", closeCleanupModal);
  document.getElementById("cleanup-cancel-btn")?.addEventListener("click", closeCleanupModal);
  document.getElementById("cleanup-apply-btn")?.addEventListener("click", applyAICleanup);

  // Re-render diff on language change if visible
  document.addEventListener("langchange", () => {
    if (
      state.pendingCleanup &&
      !document.getElementById("ai-cleanup-modal").classList.contains("hidden")
    ) {
      const diffV2 = document.getElementById("cleanup-diff-v2");
      if (!diffV2.classList.contains("hidden")) {
        // Save checkbox states
        const checkedStates = [];
        document.querySelectorAll(".diff-checkbox").forEach((cb, i) => {
          checkedStates[i] = cb.checked;
        });
        renderCleanupDiffV2(state.pendingCleanup);
        // Restore checkbox states
        document.querySelectorAll(".diff-checkbox").forEach((cb, i) => {
          if (checkedStates[i] !== undefined) cb.checked = checkedStates[i];
        });
        updateCleanupStats();
      }
    }
  });

  document.getElementById("profile-item-form")?.addEventListener("submit", submitProfileItemForm);
  document
    .getElementById("profile-item-modal-close")
    ?.addEventListener("click", closeProfileItemModal);
  document.getElementById("profile-item-cancel")?.addEventListener("click", closeProfileItemModal);
  document.getElementById("btn-add-step")?.addEventListener("click", () => addStepRow(""));

  // Event delegation for dynamically generated profile edit/delete buttons
  document.getElementById("profile-content").addEventListener("click", (e) => {
    const editBtn = e.target.closest(".btn-edit-profile-item");
    const deleteBtn = e.target.closest(".btn-delete-profile-item");
    const pageBtn = e.target.closest(".btn-page");
    if (editBtn) {
      const type = editBtn.dataset.type;
      const index = parseInt(editBtn.dataset.index, 10);
      editProfileItem(type, index);
    }
    if (deleteBtn) {
      const type = deleteBtn.dataset.type;
      const index = parseInt(deleteBtn.dataset.index, 10);
      deleteProfileItem(type, index);
    }
    if (pageBtn && !pageBtn.disabled) {
      const pageType = pageBtn.dataset.pageType;
      const page = parseInt(pageBtn.dataset.page, 10);
      state.profilePages[pageType] = page;
      refreshProfile();
    }
  });

  await loadTags();
  await loadMemories();
  await loadStats();
  await checkMigrationStatus();
  checkAuthWarning();

  startAutoRefresh();

  lucide.createIcons();
});
