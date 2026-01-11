const API_BASE = '';

const state = {
  tags: { user: [], project: [] },
  memories: [],
  currentPage: 1,
  pageSize: 20,
  totalPages: 1,
  totalItems: 0,
  selectedTag: '',
  selectedScope: '',
  searchQuery: '',
  isSearching: false,
  selectedMemories: new Set(),
  autoRefreshInterval: null,
};

async function fetchAPI(endpoint, options = {}) {
  try {
    const response = await fetch(API_BASE + endpoint, options);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('API Error:', error);
    return { success: false, error: error.message };
  }
}

async function loadTags() {
  const result = await fetchAPI('/api/tags');
  if (result.success) {
    state.tags = result.data;
    populateTagDropdowns();
  }
}

function populateTagDropdowns() {
  const tagFilter = document.getElementById('tag-filter');
  const addTag = document.getElementById('add-tag');
  
  tagFilter.innerHTML = '<option value="">All Tags</option>';
  addTag.innerHTML = '<option value="">Select tag</option>';
  
  const allTags = [...state.tags.user, ...state.tags.project];
  allTags.forEach(tagInfo => {
    const scope = tagInfo.tag.includes('_user_') ? 'user' : 'project';
    const displayText = tagInfo.displayName || tagInfo.tag;
    const shortDisplay = displayText.length > 50 ? displayText.substring(0, 50) + '...' : displayText;
    
    const option1 = document.createElement('option');
    option1.value = tagInfo.tag;
    option1.textContent = `[${scope}] ${shortDisplay}`;
    tagFilter.appendChild(option1);
    
    const option2 = document.createElement('option');
    option2.value = tagInfo.tag;
    option2.textContent = `[${scope}] ${shortDisplay}`;
    addTag.appendChild(option2);
  });
}

async function loadMemories() {
  showRefreshIndicator(true);
  
  let endpoint = `/api/memories?page=${state.currentPage}&pageSize=${state.pageSize}`;
  
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
    showError(result.error || 'Failed to load memories');
  }
}

function renderMemories() {
  const container = document.getElementById('memories-list');
  
  if (state.memories.length === 0) {
    container.innerHTML = '<div class="empty-state">No memories found</div>';
    return;
  }
  
  container.innerHTML = state.memories.map(memory => {
    const isSelected = state.selectedMemories.has(memory.id);
    const isPinned = memory.isPinned || false;
    const similarityHtml = memory.similarity !== undefined 
      ? `<span class="similarity-score">${memory.similarity}%</span>` 
      : '';
    
    const displayInfo = memory.displayName || memory.id;
    let subtitle = '';
    if (memory.scope === 'user' && memory.userEmail) {
      subtitle = `<span class="memory-subtitle">${escapeHtml(memory.userEmail)}</span>`;
    } else if (memory.scope === 'project' && memory.projectPath) {
      subtitle = `<span class="memory-subtitle">${escapeHtml(memory.projectPath)}</span>`;
    }
    
    const pinButton = isPinned 
      ? `<button class="btn-pin pinned" onclick="unpinMemory('${memory.id}')" title="Unpin"><i data-lucide="pin" class="icon icon-filled"></i></button>`
      : `<button class="btn-pin" onclick="pinMemory('${memory.id}')" title="Pin"><i data-lucide="pin" class="icon"></i></button>`;
    
    return `
      <div class="memory-card ${isSelected ? 'selected' : ''} ${isPinned ? 'pinned' : ''}" data-id="${memory.id}">
        <div class="memory-header">
          <div class="meta">
            <input type="checkbox" class="memory-checkbox" data-id="${memory.id}" ${isSelected ? 'checked' : ''} />
            <span class="badge badge-${memory.scope}">${memory.scope}</span>
            ${memory.type ? `<span class="badge badge-type">${memory.type}</span>` : ''}
            ${similarityHtml}
            ${isPinned ? '<span class="badge badge-pinned">PINNED</span>' : ''}
            <span class="memory-display-name">${escapeHtml(displayInfo)}</span>
            ${subtitle}
          </div>
          <div class="memory-actions">
            ${pinButton}
            <button class="btn-edit" onclick="editMemory('${memory.id}')"><i data-lucide="edit-3" class="icon"></i></button>
            <button class="btn-delete" onclick="deleteMemory('${memory.id}')"><i data-lucide="trash-2" class="icon"></i></button>
          </div>
        </div>
        <div class="memory-content">${escapeHtml(memory.content)}</div>
        <div class="memory-footer">
          <span>Created: ${formatDate(memory.createdAt)}</span>
          <span>ID: ${memory.id}</span>
        </div>
      </div>
    `;
  }).join('');
  
  document.querySelectorAll('.memory-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', handleCheckboxChange);
  });
  
  lucide.createIcons();
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
  const card = document.querySelector(`.memory-card[data-id="${id}"]`);
  if (card) {
    if (selected) {
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  }
}

function updateBulkActions() {
  const bulkActions = document.getElementById('bulk-actions');
  const selectedCount = document.getElementById('selected-count');
  
  if (state.selectedMemories.size > 0) {
    bulkActions.classList.remove('hidden');
    selectedCount.textContent = `${state.selectedMemories.size} selected`;
  } else {
    bulkActions.classList.add('hidden');
  }
}

function updatePagination() {
  const pageInfo = `Page ${state.currentPage} of ${state.totalPages}`;
  document.getElementById('page-info-top').textContent = pageInfo;
  document.getElementById('page-info-bottom').textContent = pageInfo;
  
  const hasPrev = state.currentPage > 1;
  const hasNext = state.currentPage < state.totalPages;
  
  document.getElementById('prev-page-top').disabled = !hasPrev;
  document.getElementById('next-page-top').disabled = !hasNext;
  document.getElementById('prev-page-bottom').disabled = !hasPrev;
  document.getElementById('next-page-bottom').disabled = !hasNext;
}

function updateSectionTitle() {
  const title = state.isSearching 
    ? `└─ SEARCH RESULTS (${state.totalItems}) ──`
    : `└─ MEMORIES (${state.totalItems}) ──`;
  document.getElementById('section-title').textContent = title;
}

async function loadStats() {
  const result = await fetchAPI('/api/stats');
  if (result.success) {
    document.getElementById('stats-total').textContent = `Total: ${result.data.total}`;
    document.getElementById('stats-user').textContent = `User: ${result.data.byScope.user}`;
    document.getElementById('stats-project').textContent = `Project: ${result.data.byScope.project}`;
  }
}

async function addMemory(e) {
  e.preventDefault();
  
  const content = document.getElementById('add-content').value.trim();
  const containerTag = document.getElementById('add-tag').value;
  const type = document.getElementById('add-type').value.trim();
  
  if (!content || !containerTag) {
    showToast('Content and tag are required', 'error');
    return;
  }
  
  const result = await fetchAPI('/api/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, containerTag, type: type || undefined })
  });
  
  if (result.success) {
    showToast('Memory added successfully', 'success');
    document.getElementById('add-form').reset();
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || 'Failed to add memory', 'error');
  }
}

async function deleteMemory(id) {
  if (!confirm('Delete this memory?')) return;
  
  const result = await fetchAPI(`/api/memories/${id}`, { method: 'DELETE' });
  
  if (result.success) {
    showToast('Memory deleted', 'success');
    state.selectedMemories.delete(id);
    await loadMemories();
    await loadStats();
    updateBulkActions();
  } else {
    showToast(result.error || 'Failed to delete memory', 'error');
  }
}

async function bulkDelete() {
  if (state.selectedMemories.size === 0) return;
  
  if (!confirm(`Delete ${state.selectedMemories.size} selected memories?`)) return;
  
  const ids = Array.from(state.selectedMemories);
  const result = await fetchAPI('/api/memories/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  
  if (result.success) {
    showToast(`Deleted ${result.data.deleted} memories`, 'success');
    state.selectedMemories.clear();
    await loadMemories();
    await loadStats();
    updateBulkActions();
  } else {
    showToast(result.error || 'Failed to delete memories', 'error');
  }
}

function deselectAll() {
  state.selectedMemories.clear();
  document.querySelectorAll('.memory-checkbox').forEach(cb => cb.checked = false);
  document.querySelectorAll('.memory-card').forEach(card => card.classList.remove('selected'));
  updateBulkActions();
}

function editMemory(id) {
  const memory = state.memories.find(m => m.id === id);
  if (!memory) return;
  
  document.getElementById('edit-id').value = memory.id;
  document.getElementById('edit-type').value = memory.type || '';
  document.getElementById('edit-content').value = memory.content;
  
  document.getElementById('edit-modal').classList.remove('hidden');
}

async function saveEdit(e) {
  e.preventDefault();
  
  const id = document.getElementById('edit-id').value;
  const type = document.getElementById('edit-type').value.trim();
  const content = document.getElementById('edit-content').value.trim();
  
  if (!content) {
    showToast('Content is required', 'error');
    return;
  }
  
  const result = await fetchAPI(`/api/memories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, type: type || undefined })
  });
  
  if (result.success) {
    showToast('Memory updated', 'success');
    closeModal();
    await loadMemories();
  } else {
    showToast(result.error || 'Failed to update memory', 'error');
  }
}

function closeModal() {
  document.getElementById('edit-modal').classList.add('hidden');
}

function performSearch() {
  const query = document.getElementById('search-input').value.trim();
  
  if (!query) {
    clearSearch();
    return;
  }
  
  state.searchQuery = query;
  state.isSearching = true;
  state.currentPage = 1;
  
  document.getElementById('clear-search-btn').classList.remove('hidden');
  
  loadMemories();
}

function clearSearch() {
  state.searchQuery = '';
  state.isSearching = false;
  state.currentPage = 1;
  
  document.getElementById('search-input').value = '';
  document.getElementById('clear-search-btn').classList.add('hidden');
  
  loadMemories();
}

function changePage(delta) {
  const newPage = state.currentPage + delta;
  if (newPage < 1 || newPage > state.totalPages) return;
  
  state.currentPage = newPage;
  loadMemories();
}

function handleFilterChange() {
  const scopeFilter = document.getElementById('scope-filter').value;
  const tagFilter = document.getElementById('tag-filter').value;
  
  if (scopeFilter) {
    const filteredTags = scopeFilter === 'user' ? state.tags.user : state.tags.project;
    state.selectedTag = filteredTags.length > 0 ? filteredTags[0].tag : '';
    
    const tagDropdown = document.getElementById('tag-filter');
    tagDropdown.innerHTML = '<option value="">All Tags</option>';
    filteredTags.forEach(tagInfo => {
      const displayText = tagInfo.displayName || tagInfo.tag;
      const shortDisplay = displayText.length > 50 ? displayText.substring(0, 50) + '...' : displayText;
      const option = document.createElement('option');
      option.value = tagInfo.tag;
      option.textContent = `[${scopeFilter}] ${shortDisplay}`;
      if (tagInfo.tag === state.selectedTag) option.selected = true;
      tagDropdown.appendChild(option);
    });
  } else {
    state.selectedTag = tagFilter;
  }
  
  state.currentPage = 1;
  loadMemories();
}

function handleAddScopeChange() {
  const scope = document.getElementById('add-scope').value;
  const tagDropdown = document.getElementById('add-tag');
  
  tagDropdown.innerHTML = '<option value="">Select tag</option>';
  
  if (!scope) return;
  
  const tags = scope === 'user' ? state.tags.user : state.tags.project;
  tags.forEach(tagInfo => {
    const displayText = tagInfo.displayName || tagInfo.tag;
    const shortDisplay = displayText.length > 50 ? displayText.substring(0, 50) + '...' : displayText;
    const option = document.createElement('option');
    option.value = tagInfo.tag;
    option.textContent = `[${scope}] ${shortDisplay}`;
    tagDropdown.appendChild(option);
  });
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

function showError(message) {
  const container = document.getElementById('memories-list');
  container.innerHTML = `<div class="error-state">Error: ${escapeHtml(message)}</div>`;
}

function showRefreshIndicator(show) {
  const indicator = document.getElementById('refresh-indicator');
  if (show) {
    indicator.classList.remove('hidden');
  } else {
    indicator.classList.add('hidden');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function pinMemory(id) {
  const result = await fetchAPI(`/api/memories/${id}/pin`, { method: 'POST' });
  
  if (result.success) {
    showToast('Memory pinned', 'success');
    await loadMemories();
  } else {
    showToast(result.error || 'Failed to pin memory', 'error');
  }
}

async function unpinMemory(id) {
  const result = await fetchAPI(`/api/memories/${id}/unpin`, { method: 'POST' });
  
  if (result.success) {
    showToast('Memory unpinned', 'success');
    await loadMemories();
  } else {
    showToast(result.error || 'Failed to unpin memory', 'error');
  }
}

async function runCleanup() {
  if (!confirm('Run cleanup? This will delete old memories (respects pinned memories).')) return;
  
  showToast('Running cleanup...', 'info');
  const result = await fetchAPI('/api/cleanup', { method: 'POST' });
  
  if (result.success) {
    const data = result.data;
    showToast(`Cleanup complete: ${data.deletedCount} deleted (user: ${data.userCount}, project: ${data.projectCount})`, 'success');
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || 'Cleanup failed', 'error');
  }
}

async function runDeduplication() {
  if (!confirm('Run deduplication? This will find and remove duplicate memories.')) return;
  
  showToast('Running deduplication...', 'info');
  const result = await fetchAPI('/api/deduplicate', { method: 'POST' });
  
  if (result.success) {
    const data = result.data;
    let message = `Deduplication complete: ${data.exactDuplicatesDeleted} exact duplicates deleted`;
    if (data.nearDuplicateGroups.length > 0) {
      message += `, ${data.nearDuplicateGroups.length} near-duplicate groups found`;
    }
    showToast(message, 'success');
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || 'Deduplication failed', 'error');
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

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('scope-filter').addEventListener('change', handleFilterChange);
  document.getElementById('tag-filter').addEventListener('change', () => {
    state.selectedTag = document.getElementById('tag-filter').value;
    state.currentPage = 1;
    loadMemories();
  });
  
  document.getElementById('add-scope').addEventListener('change', handleAddScopeChange);
  
  document.getElementById('search-btn').addEventListener('click', performSearch);
  document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
  document.getElementById('search-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
  });
  
  document.getElementById('add-form').addEventListener('submit', addMemory);
  document.getElementById('edit-form').addEventListener('submit', saveEdit);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('cancel-edit').addEventListener('click', closeModal);
  
  document.getElementById('prev-page-top').addEventListener('click', () => changePage(-1));
  document.getElementById('next-page-top').addEventListener('click', () => changePage(1));
  document.getElementById('prev-page-bottom').addEventListener('click', () => changePage(-1));
  document.getElementById('next-page-bottom').addEventListener('click', () => changePage(1));
  
  document.getElementById('bulk-delete-btn').addEventListener('click', bulkDelete);
  document.getElementById('deselect-all-btn').addEventListener('click', deselectAll);
  
  document.getElementById('cleanup-btn').addEventListener('click', runCleanup);
  document.getElementById('deduplicate-btn').addEventListener('click', runDeduplication);
  
  document.getElementById('edit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'edit-modal') closeModal();
  });
  
  await loadTags();
  await loadMemories();
  await loadStats();
  
  startAutoRefresh();
  
  lucide.createIcons();
});
