const API_BASE = "";

const state = {
  tags: { user: [], project: [] },
  memories: [],
  currentPage: 1,
  pageSize: 20,
  totalPages: 1,
  totalItems: 0,
  selectedTag: "",
  currentScope: "project",
  currentView: "project",
  searchQuery: "",
  isSearching: false,
  selectedMemories: new Set(),
  autoRefreshInterval: null,
  userProfile: null,
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
    const response = await fetch(API_BASE + endpoint, options);
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

  tagFilter.innerHTML = '<option value="">All Tags</option>';
  addTag.innerHTML = '<option value="">Select tag</option>';

  const scopeTags = state.currentScope === "user" ? state.tags.user : state.tags.project;

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

async function loadMemories() {
  showRefreshIndicator(true);

  let endpoint = `/api/memories?page=${state.currentPage}&pageSize=${state.pageSize}&scope=${state.currentScope}&includePrompts=true`;

  if (state.isSearching && state.searchQuery) {
    endpoint = `/api/search?q=${encodeURIComponent(state.searchQuery)}&page=${state.currentPage}&pageSize=${state.pageSize}`;
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

function renderMemories() {
  const container = document.getElementById("memories-list");

  if (state.memories.length === 0) {
    container.innerHTML = '<div class="empty-state">No memories found</div>';
    return;
  }

  container.innerHTML = state.memories
    .map((item) => {
      if (item.type === "prompt") {
        return renderPromptCard(item);
      } else {
        return renderMemoryCard(item);
      }
    })
    .join("");

  document.querySelectorAll(".memory-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", handleCheckboxChange);
  });

  lucide.createIcons();
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
  if (memory.scope === "project" && memory.projectPath) {
    const pathParts = memory.projectPath.split("/");
    displayInfo = pathParts[pathParts.length - 1] || memory.projectPath;
  }

  let subtitle = "";
  if (memory.scope === "user" && memory.userEmail) {
    subtitle = `<span class="memory-subtitle">${escapeHtml(memory.userEmail)}</span>`;
  } else if (memory.scope === "project" && memory.projectPath) {
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

  return `
    <div class="memory-card ${isSelected ? "selected" : ""} ${isPinned ? "pinned" : ""}" data-id="${memory.id}">
      <div class="memory-header">
        <div class="meta">
          <input type="checkbox" class="memory-checkbox" data-id="${memory.id}" ${isSelected ? "checked" : ""} />
          <span class="badge badge-${memory.scope}">${memory.scope}</span>
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
  const scopeName = state.currentScope.toUpperCase();
  const title = state.isSearching
    ? `└─ SEARCH RESULTS (${state.totalItems}) ──`
    : `└─ ${scopeName} MEMORIES (${state.totalItems}) ──`;
  document.getElementById("section-title").textContent = title;
}

async function loadStats() {
  const result = await fetchAPI("/api/stats");
  if (result.success) {
    document.getElementById("stats-total").textContent = `Total: ${result.data.total}`;
    document.getElementById("stats-user").textContent = `User: ${result.data.byScope.user}`;
    document.getElementById("stats-project").textContent =
      `Project: ${result.data.byScope.project}`;
  }
}

async function addMemory(e) {
  e.preventDefault();

  const content = document.getElementById("add-content").value.trim();
  const containerTag = document.getElementById("add-tag").value;
  const type = document.getElementById("add-type").value.trim();

  if (!content || !containerTag) {
    showToast("Content and tag are required", "error");
    return;
  }

  const result = await fetchAPI("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, containerTag, type: type || undefined }),
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
  document.getElementById("edit-type").value = memory.memoryType || "";
  document.getElementById("edit-content").value = memory.content;

  document.getElementById("edit-modal").classList.remove("hidden");
}

async function saveEdit(e) {
  e.preventDefault();

  const id = document.getElementById("edit-id").value;
  const type = document.getElementById("edit-type").value.trim();
  const content = document.getElementById("edit-content").value.trim();

  if (!content) {
    showToast("Content is required", "error");
    return;
  }

  const result = await fetchAPI(`/api/memories/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, type: type || undefined }),
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

function handleAddScopeChange() {
  const scope = document.getElementById("add-scope").value;
  const tagDropdown = document.getElementById("add-tag");

  tagDropdown.innerHTML = '<option value="">Select tag</option>';

  if (!scope || scope !== "project") return;

  const tags = state.tags.project;
  tags.forEach((tagInfo) => {
    const displayText = tagInfo.displayName || tagInfo.tag;
    const shortDisplay =
      displayText.length > 50 ? displayText.substring(0, 50) + "..." : displayText;
    const option = document.createElement("option");
    option.value = tagInfo.tag;
    option.textContent = shortDisplay;
    tagDropdown.appendChild(option);
  });
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

  const data = profile.profileData;
  const preferences = data.preferences || [];
  const patterns = data.patterns || [];
  const workflows = data.workflows || [];
  const skillLevel = data.skillLevel || {};

  container.innerHTML = `
    <div class="profile-header">
      <div class="profile-info">
        <h3>${profile.displayName || profile.userId}</h3>
        <p class="profile-meta">
          <span>Version: ${profile.version}</span>
          <span class="separator">|</span>
          <span>Analyzed: ${profile.totalPromptsAnalyzed} prompts</span>
          <span class="separator">|</span>
          <span>Updated: ${formatDate(profile.lastAnalyzedAt)}</span>
        </p>
      </div>
      <button id="view-changelog-btn" class="btn-secondary">
        <i data-lucide="history" class="icon"></i> Version History
      </button>
    </div>

    <div class="profile-section">
      <h4><i data-lucide="heart" class="icon"></i> Preferences (${preferences.length})</h4>
      ${
        preferences.length === 0
          ? '<p class="empty-text">No preferences learned yet</p>'
          : `
        <div class="preferences-list">
          ${preferences
            .map(
              (p) => `
            <div class="preference-item">
              <div class="preference-header">
                <span class="preference-name">${escapeHtml(p.description)}</span>
                <span class="confidence-badge">${Math.round(p.confidence * 100)}%</span>
              </div>
              <div class="confidence-bar">
                <div class="confidence-fill" style="width: ${p.confidence * 100}%"></div>
              </div>
              <p class="preference-evidence">${escapeHtml(Array.isArray(p.evidence) ? p.evidence.join(", ") : p.evidence)}</p>
              <p class="preference-meta">Category: ${escapeHtml(p.category)}</p>
            </div>
          `
            )
            .join("")}
        </div>
      `
      }
    </div>

    <div class="profile-section">
      <h4><i data-lucide="activity" class="icon"></i> Patterns (${patterns.length})</h4>
      ${
        patterns.length === 0
          ? '<p class="empty-text">No patterns detected yet</p>'
          : `
        <div class="patterns-list">
          ${patterns
            .map(
              (p) => `
            <div class="pattern-item">
              <div class="pattern-header">
                <span class="pattern-name">${escapeHtml(p.description)}</span>
                <span class="category-badge">${escapeHtml(p.category)}</span>
              </div>
            </div>
          `
            )
            .join("")}
        </div>
      `
      }
    </div>

    <div class="profile-section">
      <h4><i data-lucide="workflow" class="icon"></i> Workflows (${workflows.length})</h4>
      ${
        workflows.length === 0
          ? '<p class="empty-text">No workflows identified yet</p>'
          : `
        <div class="workflows-list">
          ${workflows
            .map(
              (w) => `
            <div class="workflow-item">
              <div class="workflow-header">
                <span class="workflow-name">${escapeHtml(w.description)}</span>
              </div>
              <div class="workflow-steps">
                ${w.steps
                  .map(
                    (step) => `
                  <div class="workflow-step">
                    <span class="step-text">${escapeHtml(step)}</span>
                  </div>
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

    <div class="profile-section">
      <h4><i data-lucide="award" class="icon"></i> Skill Level</h4>
      <div class="skill-level">
        <div class="skill-item">
          <span class="skill-label">Overall</span>
          <span class="skill-value">${escapeHtml(skillLevel.overall || "unknown")}</span>
        </div>
        ${Object.entries(skillLevel.domains || {})
          .map(
            ([domain, level]) => `
          <div class="skill-item">
            <span class="skill-label">${escapeHtml(domain)}</span>
            <span class="skill-value">${escapeHtml(level)}</span>
          </div>
        `
          )
          .join("")}
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

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("tab-project").addEventListener("click", () => switchView("project"));
  document.getElementById("tab-profile").addEventListener("click", () => switchView("profile"));
  document.getElementById("refresh-profile-btn")?.addEventListener("click", refreshProfile);
  document.getElementById("changelog-close")?.addEventListener("click", () => {
    document.getElementById("changelog-modal").classList.add("hidden");
  });

  document.getElementById("tag-filter").addEventListener("change", () => {
    state.selectedTag = document.getElementById("tag-filter").value;
    state.currentPage = 1;
    loadMemories();
  });

  document.getElementById("add-scope").addEventListener("change", handleAddScopeChange);

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
