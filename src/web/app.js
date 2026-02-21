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
  currentTag: "",
  currentProjectPath: "",
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
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(API_BASE + endpoint, {
      ...options,
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
  const knowledgeProjectFilter = document.getElementById("knowledge-project-filter");

  tagFilter.innerHTML = '<option value="">All Tags</option>';
  addTag.innerHTML = '<option value="">Select tag</option>';
  knowledgeProjectFilter.innerHTML = '<option value="">Select Project</option>';

  const scopeTags = state.tags.project;

  scopeTags.forEach((tagInfo) => {
    const displayText = tagInfo.displayName || tagInfo.tag;
    const shortDisplay =
      displayText.length > 50 ? displayText.substring(0, 50) + "..." : displayText;

    const option1 = document.createElement("option");
    option1.value = tagInfo.tag;
    option1.textContent = shortDisplay;
    option1.dataset.projectPath = tagInfo.projectPath || "";
    tagFilter.appendChild(option1);

    const option2 = document.createElement("option");
    option2.value = tagInfo.tag;
    option2.textContent = shortDisplay;
    addTag.appendChild(option2);

    const option3 = document.createElement("option");
    option3.value = tagInfo.tag;
    option3.textContent = shortDisplay;
    option3.dataset.projectPath = tagInfo.projectPath || "";
    knowledgeProjectFilter.appendChild(option3);
  });
}

function renderMemories() {
  const container = document.getElementById("memories-list");

  if (state.memories.length === 0) {
    container.innerHTML = '<div class="empty-state">No memories found</div>';
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
    ? `<span>Created: ${createdDate}</span><span>Updated: ${updatedDate}</span>`
    : `<span>Created: ${createdDate}</span>`;

  return `
    <div class="combined-card ${isSelected ? "selected" : ""} ${isPinned ? "pinned" : ""}" data-id="${memory.id}">
      <div class="combined-prompt-section">
        <div class="combined-header">
          <span class="badge badge-prompt">USER PROMPT</span>
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
            <span class="badge badge-memory">MEMORY</span>
            ${memory.memoryType ? `<span class="badge badge-type">${memory.memoryType}</span>` : ""}
            ${similarityHtml}
            ${isPinned ? '<span class="badge badge-pinned">PINNED</span>' : ""}
            <span class="memory-display-name">${escapeHtml(memory.displayName || memory.id)}</span>
          </div>
          <div class="memory-actions">
            ${pinButton}
            <button class="btn-edit" onclick="editMemory('${memory.id}')"><i data-lucide="edit-3" class="icon"></i></button>
            <button class="btn-delete" onclick="deleteMemoryWithLink('${memory.id}', true)">
              <i data-lucide="trash-2" class="icon"></i> Delete Pair
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
          <span class="badge badge-prompt">USER PROMPT</span>
          ${isLinked ? '<span class="badge badge-linked"><i data-lucide="link" class="icon-sm"></i> LINKED</span>' : ""}
          <span class="prompt-date">${promptDate}</span>
        </div>
        <div class="prompt-actions">
          <button class="btn-delete" onclick="deletePromptWithLink('${prompt.id}', ${isLinked})">
            <i data-lucide="trash-2" class="icon"></i>
            ${isLinked ? "Delete Pair" : "Delete"}
          </button>
        </div>
      </div>
      <div class="prompt-content">
        ${escapeHtml(prompt.content)}
      </div>
      ${isLinked ? '<div class="link-indicator"><i data-lucide="arrow-down" class="icon-sm"></i> Generated memory above <i data-lucide="arrow-up" class="icon-sm"></i></div>' : ""}
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
    ? `<span>Created: ${createdDate}</span><span>Updated: ${updatedDate}</span>`
    : `<span>Created: ${createdDate}</span>`;

  const tagsHtml =
    memory.tags && memory.tags.length > 0
      ? `<div class="tags-list">${memory.tags.map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

  return `
    <div class="memory-card ${isSelected ? "selected" : ""} ${isPinned ? "pinned" : ""}" data-id="${memory.id}">
      <div class="memory-header">
        <div class="meta">
          <input type="checkbox" class="memory-checkbox" data-id="${memory.id}" ${isSelected ? "checked" : ""} />
          ${memory.memoryType ? `<span class="badge badge-type">${memory.memoryType}</span>` : ""}
          ${isLinked ? '<span class="badge badge-linked"><i data-lucide="link" class="icon-sm"></i> LINKED</span>' : ""}
          ${similarityHtml}
          ${isPinned ? '<span class="badge badge-pinned">PINNED</span>' : ""}
          <span class="memory-display-name">${escapeHtml(displayInfo)}</span>
          ${subtitle}
        </div>
        <div class="memory-actions">
          ${pinButton}
          <button class="btn-edit" onclick="editMemory('${memory.id}')"><i data-lucide="edit-3" class="icon"></i></button>
          <button class="btn-delete" onclick="deleteMemoryWithLink('${memory.id}', ${isLinked})">
            <i data-lucide="trash-2" class="icon"></i>
            ${isLinked ? "Delete Pair" : "Delete"}
          </button>
        </div>
      </div>
      ${tagsHtml}
      <div class="memory-content markdown-content">${renderMarkdown(memory.content)}</div>
      ${isLinked ? '<div class="link-indicator"><i data-lucide="arrow-up" class="icon-sm"></i> From prompt below <i data-lucide="arrow-down" class="icon-sm"></i></div>' : ""}
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
    selectedCount.textContent = `${state.selectedMemories.size} selected`;
  } else {
    bulkActions.classList.add("hidden");
  }
}

function updatePagination() {
  const pageInfo = `Page ${state.currentPage} of ${state.totalPages}`;
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
    : `└─ PROJECT MEMORIES (${state.totalItems}) ──`;
  document.getElementById("section-title").textContent = title;
}

async function loadStats() {
  const result = await fetchAPI("/api/stats");
  if (result.success) {
    document.getElementById("stats-total").textContent = `Total: ${result.data.total}`;
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
    showToast("Content and tag are required", "error");
    return;
  }

  const result = await fetchAPI("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, containerTag, type: type || undefined, tags }),
  });

  if (result.success) {
    showToast("Memory added successfully", "success");
    document.getElementById("add-form").reset();
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Failed to add memory", "error");
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
    showError(result.error || "Failed to load memories");
  }
}

async function deleteMemoryWithLink(id, isLinked) {
  const message = isLinked ? "Delete this memory AND its linked prompt?" : "Delete this memory?";

  if (!confirm(message)) return;

  const result = await fetchAPI(`/api/memories/${id}?cascade=true`, {
    method: "DELETE",
  });

  if (result.success) {
    const msg = result.data?.deletedPrompt ? "Memory and linked prompt deleted" : "Memory deleted";
    showToast(msg, "success");

    state.selectedMemories.delete(id);
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Failed to delete", "error");
  }
}

async function deletePromptWithLink(id, isLinked) {
  const message = isLinked
    ? "Delete this prompt AND its linked memory summary?"
    : "Delete this prompt?";

  if (!confirm(message)) return;

  const result = await fetchAPI(`/api/prompts/${id}?cascade=true`, {
    method: "DELETE",
  });

  if (result.success) {
    const msg = result.data?.deletedMemory ? "Prompt and linked memory deleted" : "Prompt deleted";
    showToast(msg, "success");

    state.selectedMemories.delete(id);
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Failed to delete", "error");
  }
}

async function bulkDelete() {
  if (state.selectedMemories.size === 0) return;

  const message = `Delete ${state.selectedMemories.size} selected items (including linked pairs)?`;
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

  showToast(`Deleted ${deletedCount} items (including linked pairs)`, "success");
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
    showToast("Content is required", "error");
    return;
  }

  const result = await fetchAPI(`/api/memories/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (result.success) {
    showToast("Memory updated", "success");
    closeModal();
    await loadMemories();
  } else {
    showToast(result.error || "Failed to update memory", "error");
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
  return date.toLocaleString("en-US", {
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
    showToast("Memory pinned", "success");
    await loadMemories();
  } else {
    showToast(result.error || "Failed to pin memory", "error");
  }
}

async function unpinMemory(id) {
  const result = await fetchAPI(`/api/memories/${id}/unpin`, { method: "POST" });

  if (result.success) {
    showToast("Memory unpinned", "success");
    await loadMemories();
  } else {
    showToast(result.error || "Failed to unpin memory", "error");
  }
}

async function runCleanup() {
  if (!confirm("Run cleanup? This will delete old memories (respects pinned memories).")) return;

  showToast("Running cleanup...", "info");
  const result = await fetchAPI("/api/cleanup", { method: "POST" });

  if (result.success) {
    const data = result.data;
    showToast(
      `Cleanup complete: ${data.deletedCount} deleted (user: ${data.userCount}, project: ${data.projectCount})`,
      "success"
    );
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Cleanup failed", "error");
  }
}

async function runDeduplication() {
  if (!confirm("Run deduplication? This will find and remove duplicate memories.")) return;

  showToast("Running deduplication...", "info");
  const result = await fetchAPI("/api/deduplicate", { method: "POST" });

  if (result.success) {
    const data = result.data;
    let message = `Deduplication complete: ${data.exactDuplicatesDeleted} exact duplicates deleted`;
    if (data.nearDuplicateGroups.length > 0) {
      message += `, ${data.nearDuplicateGroups.length} near-duplicate groups found`;
    }
    showToast(message, "success");
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Deduplication failed", "error");
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
  status.textContent = `Found ${count} memories needing technical tags.`;
  overlay.classList.remove("hidden");

  document.getElementById("start-tag-migration-btn").onclick = runTagMigration;
}

async function runTagMigration() {
  const actions = document.getElementById("tag-migration-actions");
  const status = document.getElementById("tag-migration-status");
  const progress = document.getElementById("tag-migration-progress");

  actions.classList.add("hidden");
  status.textContent = "Starting migration...";
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
      status.textContent = "Migration failed: " + result.error;
      actions.classList.remove("hidden");
      return;
    }

    totalProcessed = result.data.processed;
    hasMore = result.data.hasMore;
    const total = result.data.total;
    const percent = total > 0 ? Math.round((totalProcessed / total) * 100) : 0;

    progress.style.width = percent + "%";
    status.textContent = `Processing memories... ${totalProcessed}/${total} (${percent}%)`;

    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (attempts >= maxAttempts) {
    status.textContent = "Migration stopped: maximum attempts reached";
    actions.classList.remove("hidden");
    return;
  }

  progress.style.width = "100%";
  status.textContent = `Successfully tagged ${totalProcessed} memories!`;
  showToast("Migration complete", "success");
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
      ? `${data.shardMismatches.length} shard(s) have different dimensions`
      : "dimension mismatch detected";

  message.textContent = `Model mismatch: Config uses ${data.configDimensions}D (${data.configModel}), but ${shardInfo}.`;
  section.classList.remove("hidden");

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
    showToast("Please confirm you understand this operation is irreversible", "error");
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

  showToast("Running migration... This may take a while.", "info");

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

    showToast(message, "success");

    document.getElementById("migration-section").classList.add("hidden");
    document.getElementById("migration-confirm-checkbox").checked = false;

    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Migration failed", "error");
  }
}

async function loadUserProfile() {
  const result = await fetchAPI("/api/user-profile");
  if (result.success) {
    state.userProfile = result.data;
    renderUserProfile();
  } else {
    showError(result.error || "Failed to load profile");
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

  const preferences = parseField(data.preferences);
  const patterns = parseField(data.patterns);
  const workflows = parseField(data.workflows);

  container.innerHTML = `
    <div class="profile-header">
      <div class="profile-info">
        <h3>${profile.displayName || profile.userId}</h3>
        <div class="profile-stats">
          <div class="stat-pill">
            <span class="label">VERSION</span>
            <span class="value">${profile.version}</span>
          </div>
          <div class="stat-pill">
            <span class="label">PROMPTS</span>
            <span class="value">${profile.totalPromptsAnalyzed}</span>
          </div>
          <div class="stat-pill">
            <span class="label">LAST UPDATED</span>
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
        <h4><i data-lucide="heart" class="icon"></i> PREFERENCES <span class="count">${preferences.length}</span></h4>
        ${
          preferences.length === 0
            ? '<p class="empty-text">No preferences learned yet</p>'
            : `
          <div class="cards-grid">
            ${preferences
              .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
              .map(
                (p) => `
              <div class="compact-card preference-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(p.category || "General")}</span>
                  <div class="confidence-ring" style="--p:${Math.round((p.confidence || 0) * 100)}">
                    <span>${Math.round((p.confidence || 0) * 100)}%</span>
                  </div>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(p.description || "")}</p>
                </div>
                ${
                  p.evidence && p.evidence.length > 0
                    ? `
                <div class="card-footer">
                  <span class="evidence-toggle" title="${escapeHtml(Array.isArray(p.evidence) ? p.evidence.join("\n") : p.evidence)}">
                    <i data-lucide="info" class="icon-xs"></i> ${Array.isArray(p.evidence) ? p.evidence.length : 1} evidence
                  </span>
                </div>`
                    : ""
                }
              </div>
            `
              )
              .join("")}
          </div>
        `
        }
      </div>

      <div class="dashboard-section patterns-section">
        <h4><i data-lucide="activity" class="icon"></i> PATTERNS <span class="count">${patterns.length}</span></h4>
        ${
          patterns.length === 0
            ? '<p class="empty-text">No patterns detected yet</p>'
            : `
          <div class="cards-grid">
            ${patterns
              .map(
                (p) => `
              <div class="compact-card pattern-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(p.category || "General")}</span>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(p.description || "")}</p>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        `
        }
      </div>

      <div class="dashboard-section workflows-section full-width">
        <h4><i data-lucide="workflow" class="icon"></i> WORKFLOWS <span class="count">${workflows.length}</span></h4>
        ${
          workflows.length === 0
            ? '<p class="empty-text">No workflows identified yet</p>'
            : `
          <div class="workflows-grid">
            ${workflows
              .map(
                (w) => `
              <div class="workflow-row">
                <div class="workflow-title">${escapeHtml(w.description || "")}</div>
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
              </div>
            `
              )
              .join("")}
          </div>
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
  list.innerHTML = '<div class="loading">Loading changelog...</div>';

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
    list.innerHTML = '<div class="empty-state">No changelog available</div>';
  }
}

async function refreshProfile() {
  showToast("Refreshing profile...", "info");
  const result = await fetchAPI("/api/user-profile/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (result.success) {
    showToast(result.data.message, "success");
    await loadUserProfile();
  } else {
    showToast(result.error || "Failed to refresh profile", "error");
  }
}

function switchView(view) {
  state.currentView = view;

  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));

  if (view === "project") {
    document.getElementById("tab-project").classList.add("active");
    document.getElementById("project-section").classList.remove("hidden");
    document.getElementById("profile-section").classList.add("hidden");
    document.getElementById("knowledge-section").classList.add("hidden");
    document.querySelector(".controls").classList.remove("hidden");
    document.querySelector(".add-section").classList.remove("hidden");
  } else if (view === "profile") {
    document.getElementById("tab-profile").classList.add("active");
    document.getElementById("project-section").classList.add("hidden");
    document.getElementById("profile-section").classList.remove("hidden");
    document.getElementById("knowledge-section").classList.add("hidden");
    document.querySelector(".controls").classList.add("hidden");
    document.querySelector(".add-section").classList.add("hidden");
    loadUserProfile();
  } else if (view === "knowledge") {
    document.getElementById("tab-knowledge").classList.add("active");
    document.getElementById("project-section").classList.add("hidden");
    document.getElementById("profile-section").classList.add("hidden");
    document.getElementById("knowledge-section").classList.remove("hidden");
    document.querySelector(".controls").classList.add("hidden");
    document.querySelector(".add-section").classList.add("hidden");
    // Only load if a project is already selected
    const projectFilter = document.getElementById("knowledge-project-filter");
    if (projectFilter?.value) {
      loadTeamKnowledge();
      loadKnowledgeStats();
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Team Knowledge Functions
async function loadTeamKnowledge() {
  const type = document.getElementById("knowledge-type-filter")?.value || "";
  const projectFilter = document.getElementById("knowledge-project-filter");
  const tag = projectFilter?.value || "";

  if (!tag) {
    document.getElementById("knowledge-list").innerHTML =
      '<div class="empty-state">Select a project to view team knowledge</div>';
    document.getElementById("knowledge-stats").innerHTML = "";
    return;
  }

  // Update state for sync
  const selectedOption = projectFilter.options[projectFilter.selectedIndex];
  state.currentTag = tag;
  state.currentProjectPath = selectedOption?.dataset?.projectPath || tag;

  try {
    const params = new URLSearchParams({ tag, pageSize: "50" });
    if (type) params.append("type", type);

    const response = await fetchAPI(`/api/team-knowledge?${params}`);

    if (response.success && response.data?.items) {
      renderKnowledgeList(response.data.items);
    } else {
      document.getElementById("knowledge-list").innerHTML =
        '<div class="empty-state">No knowledge found. Click "Sync Now" to extract knowledge from your codebase.</div>';
    }
  } catch (error) {
    console.error("Failed to load knowledge:", error);
    document.getElementById("knowledge-list").innerHTML =
      '<div class="error-state">Failed to load knowledge</div>';
  }
}

function renderKnowledgeList(items) {
  const container = document.getElementById("knowledge-list");

  if (!items.length) {
    container.innerHTML =
      '<div class="empty-state">No knowledge items found. Click "Sync Now" to extract knowledge from your codebase.</div>';
    return;
  }

  container.innerHTML = items
    .map(
      (item) => `
    <div class="knowledge-item" data-id="${item.id}">
      <div class="knowledge-item-header">
        <span class="knowledge-type knowledge-type-${item.type}">${item.type}</span>
        <span class="knowledge-title">${escapeHtml(item.title)}</span>
      </div>
      <div class="knowledge-item-meta">
        <span class="knowledge-source">${item.sourceFile || "N/A"}</span>
        <span class="knowledge-confidence">${Math.round(item.confidence * 100)}%</span>
      </div>
    </div>
  `
    )
    .join("");

  // Add click handlers
  container.querySelectorAll(".knowledge-item").forEach((el) => {
    el.addEventListener("click", () =>
      showKnowledgeDetail(items.find((i) => i.id === el.dataset.id))
    );
  });

  lucide.createIcons();
}

function showKnowledgeDetail(item) {
  const detail = document.getElementById("knowledge-detail");
  const list = document.getElementById("knowledge-list");

  detail.innerHTML = `
    <button class="btn btn-back" onclick="hideKnowledgeDetail()">
      <i data-lucide="arrow-left" class="icon"></i> Back
    </button>
    <div class="knowledge-detail-content">
      <h3>${escapeHtml(item.title)}</h3>
      <div class="knowledge-meta">
        <span class="knowledge-type knowledge-type-${item.type}">${item.type}</span>
        <span>Source: ${item.sourceFile || "N/A"}</span>
        <span>Confidence: ${Math.round(item.confidence * 100)}%</span>
        <span>Version: ${item.version}</span>
        <span>Updated: ${new Date(item.updatedAt).toLocaleString()}</span>
      </div>
      <div class="knowledge-content markdown-content">${renderMarkdown(item.content)}</div>
      <div class="knowledge-tags">Tags: ${item.tags?.join(", ") || "None"}</div>
      <button class="btn-delete" onclick="deleteKnowledge('${item.id}')">
        <i data-lucide="trash-2" class="icon"></i> Delete
      </button>
    </div>
  `;

  list.style.display = "none";
  detail.style.display = "block";
  lucide.createIcons();
}

function hideKnowledgeDetail() {
  document.getElementById("knowledge-list").style.display = "flex";
  document.getElementById("knowledge-detail").style.display = "none";
}

async function syncKnowledge() {
  const btn = document.getElementById("sync-knowledge-btn");
  const projectFilter = document.getElementById("knowledge-project-filter");
  const selectedOption = projectFilter?.options[projectFilter.selectedIndex];
  const projectPath = selectedOption?.dataset?.projectPath || state.currentProjectPath;

  if (!projectPath || projectFilter?.value === "") {
    showToast("Select a project first", "error");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader" class="icon icon-spin"></i> Syncing...';
  lucide.createIcons();

  try {
    const response = await fetchAPI("/api/team-knowledge/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath }),
    });

    if (response.success) {
      showToast(
        `Synced: +${response.data.added}, ~${response.data.updated}, -${response.data.stale}`,
        "success"
      );
      loadTeamKnowledge();
      loadKnowledgeStats();
    } else {
      showToast(response.error || "Sync failed", "error");
    }
  } catch (error) {
    showToast("Sync failed: " + error.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw" class="icon"></i> Sync Now';
    lucide.createIcons();
  }
}

async function loadKnowledgeStats() {
  const projectFilter = document.getElementById("knowledge-project-filter");
  const tag = projectFilter?.value || state.currentTag;
  if (!tag) return;

  try {
    const response = await fetchAPI(`/api/team-knowledge/stats?tag=${encodeURIComponent(tag)}`);

    if (response.success && response.data) {
      const stats = response.data;
      document.getElementById("knowledge-stats").innerHTML = `
        <span>Total: ${stats.total}</span>
        <span>Last sync: ${stats.lastSync ? new Date(stats.lastSync).toLocaleString() : "Never"}</span>
      `;
    }
  } catch (error) {
    console.error("Failed to load stats:", error);
  }
}

async function deleteKnowledge(id) {
  if (!confirm("Delete this knowledge item?")) return;

  try {
    const response = await fetchAPI(`/api/team-knowledge/${id}`, { method: "DELETE" });

    if (response.success) {
      showToast("Deleted", "success");
      hideKnowledgeDetail();
      loadTeamKnowledge();
    } else {
      showToast(response.error || "Delete failed", "error");
    }
  } catch (error) {
    showToast("Delete failed", "error");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("tab-project").addEventListener("click", () => switchView("project"));
  document.getElementById("tab-profile").addEventListener("click", () => switchView("profile"));
  document.getElementById("tab-knowledge").addEventListener("click", () => switchView("knowledge"));
  document.getElementById("refresh-profile-btn")?.addEventListener("click", refreshProfile);
  document.getElementById("changelog-close")?.addEventListener("click", () => {
    document.getElementById("changelog-modal").classList.add("hidden");
  });

  // Team Knowledge event listeners
  document.getElementById("knowledge-project-filter")?.addEventListener("change", () => {
    loadTeamKnowledge();
    loadKnowledgeStats();
  });
  document.getElementById("knowledge-type-filter")?.addEventListener("change", loadTeamKnowledge);
  document.getElementById("sync-knowledge-btn")?.addEventListener("click", syncKnowledge);

  document.getElementById("tag-filter").addEventListener("change", () => {
    state.selectedTag = document.getElementById("tag-filter").value;
    state.currentTag = state.selectedTag;
    // Try to get project path from tag info
    const tagInfo = state.tags.project.find((t) => t.tag === state.selectedTag);
    state.currentProjectPath = tagInfo?.projectPath || state.selectedTag;
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

  await loadTags();
  await loadMemories();
  await loadStats();
  await checkMigrationStatus();

  startAutoRefresh();

  lucide.createIcons();
});
