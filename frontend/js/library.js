let lists = [];
let downloadsByList = new Map();
let liveById = new Map();
let selectedListId = null;
let librarySettings = { ...SETTINGS_DEFAULTS };

const statusOrder = ['downloading', 'queued', 'paused', 'failed', 'pending', 'completed'];
const runningStatuses = new Set(['downloading', 'queued']);
const startableStatuses = new Set(['pending', 'failed']);

function mergedDownload(dl) {
  const live = liveById.get(dl.id) || {};
  return { ...dl, ...live, status: live.status || dl.status };
}

function proxiedImage(url) {
  if (!url) return '';
  return `/api/image?url=${encodeURIComponent(url)}`;
}

async function loadLibrarySettings() {
  librarySettings = await getSettings();
  applyInterfaceSettings(librarySettings);
}

async function loadLibrary() {
  const root = document.getElementById('library');
  root.innerHTML = '<div class="loading"><span class="spinner"></span> Loading library...</div>';
  const data = await API.req('/api/lists');
  if (!data) return;
  lists = data;
  downloadsByList = new Map();

  await Promise.all(lists.map(async (lst) => {
    const dls = await API.req(`/api/lists/${lst.id}/downloads`);
    if (dls) downloadsByList.set(lst.id, dls);
  }));

  if (selectedListId && !lists.some(l => l.id === selectedListId)) selectedListId = null;
  if (!selectedListId && boolSetting(librarySettings.library_default_detail) && lists.length) {
    selectedListId = lists[0].id;
  }
  renderLibrary();
}

function renderStats() {
  const stats = document.getElementById('library-stats');
  const files = [...downloadsByList.values()].flat().map(mergedDownload);
  const running = files.filter(d => runningStatuses.has(d.status)).length;
  const paused = files.filter(d => d.status === 'paused').length;
  const done = files.filter(d => d.status === 'completed').length;
  const totalBytes = files.reduce((s, d) => s + (d.total_bytes || 0), 0);

  stats.innerHTML = `
    <div class="stat-card"><strong>${lists.length}</strong><span>Games</span></div>
    <div class="stat-card"><strong>${files.length}</strong><span>Files</span></div>
    <div class="stat-card"><strong>${done}</strong><span>Done</span></div>
    <div class="stat-card"><strong>${running}</strong><span>Running</span></div>
    <div class="stat-card"><strong>${paused}</strong><span>Paused</span></div>
    <div class="stat-card"><strong>${fmtBytes(totalBytes, 'Unknown')}</strong><span>Known size</span></div>`;
}

function gameProgress(downloads) {
  if (!downloads.length) return { pct: 0, downloaded: 0, total: 0, completed: 0 };
  const merged = downloads.map(mergedDownload);
  const total = merged.reduce((s, d) => s + (d.total_bytes || 0), 0);
  const downloaded = merged.reduce((s, d) => s + (d.bytes_downloaded || 0), 0);
  const completed = merged.filter(d => d.status === 'completed').length;
  const pct = total ? downloaded / total * 100 : completed / downloads.length * 100;
  return { pct, downloaded, total, completed };
}

function gameAction(downloads) {
  const merged = downloads.map(mergedDownload);
  if (merged.some(d => runningStatuses.has(d.status))) return { label: 'Pause', disabled: false };
  if (merged.some(d => d.status === 'paused' || startableStatuses.has(d.status))) return { label: 'Start', disabled: false };
  return { label: 'Done', disabled: true };
}

function renderLibrary() {
  renderStats();
  const root = document.getElementById('library');
  if (!lists.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">Library</div>
        <h3>No games in your library</h3>
        <p>Add a repack from Browse to see it here.</p>
      </div>`;
    return;
  }

  if (selectedListId) {
    const selected = lists.find(l => l.id === selectedListId);
    if (selected) {
      root.innerHTML = renderDetail(selected);
      return;
    }
  }

  const sizeClass = `card-size-${librarySettings.library_card_size || 'medium'}`;
  root.innerHTML = `<div class="library-grid ${sizeClass}">${lists.map(renderLibraryCard).join('')}</div>`;
}

function renderLibraryCard(lst) {
  const downloads = (downloadsByList.get(lst.id) || []).map(mergedDownload);
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const image = proxiedImage(lst.image_url);
  const total = p.total ? fmtBytes(p.total) : (lst.size || 'Unknown size');

  return `<article class="library-card" data-action="open-list" data-list-id="${lst.id}" tabindex="0">
    <div class="library-cover-wrap">
      ${image
        ? `<img class="library-cover" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<div class="library-cover-placeholder">${esc(initials(lst.name))}</div>`}
      <span class="size-chip">${esc(total)}</span>
    </div>
    <div class="library-card-body">
      <h2 class="library-card-title" title="${esc(lst.name)}">${esc(lst.name)}</h2>
      <div class="library-card-meta">
        <span data-card-files>${p.completed}/${downloads.length} files</span>
        <span data-card-pct>${p.pct.toFixed(0)}%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" data-card-fill style="width:${Math.min(100, p.pct).toFixed(1)}%"></div></div>
      <div class="library-card-actions">
        <button class="btn btn-primary btn-sm" data-action="toggle-game" data-card-action type="button" ${action.disabled ? 'disabled' : ''}>${action.label}</button>
        <button class="btn btn-ghost btn-sm" data-action="open-list" type="button">Details</button>
      </div>
    </div>
  </article>`;
}

function renderDetail(lst) {
  const downloads = (downloadsByList.get(lst.id) || [])
    .map(mergedDownload)
    .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const image = proxiedImage(lst.image_url);
  const cats = (lst.categories || []).slice(0, 6);
  const total = p.total ? fmtBytes(p.total) : (lst.size || 'Unknown size');
  const description = lst.description || 'No description saved yet.';

  return `<section class="library-detail" data-list-id="${lst.id}">
    <aside class="detail-side">
      <button class="back-link" data-action="back" type="button">Back</button>
      <div class="detail-cover-wrap">
        ${image
          ? `<img class="detail-cover" src="${esc(image)}" alt="" referrerpolicy="no-referrer">`
          : `<div class="detail-cover-placeholder">${esc(initials(lst.name))}</div>`}
      </div>
      <h2 class="detail-title">${esc(lst.name)}</h2>
      <div class="detail-meta">
        <span data-detail-total>${esc(total)}</span>
        <span data-detail-files>${downloads.length} files</span>
        <span data-detail-pct>${p.pct.toFixed(0)}%</span>
      </div>
      <div class="detail-tags">${cats.map(c => `<span>${esc(c)}</span>`).join('')}</div>
      <p class="detail-description">${esc(description)}</p>
      <button class="btn btn-primary btn-fw" data-action="toggle-game" data-detail-action type="button" ${action.disabled ? 'disabled' : ''}>${action.label}</button>
      ${lst.source_url ? `<a class="btn btn-ghost btn-fw" href="${esc(lst.source_url)}" target="_blank" rel="noopener">FitGirl page</a>` : ''}
      <button class="btn btn-danger btn-fw" data-action="delete-game" type="button">Delete</button>
    </aside>
    <div class="detail-main">
      <div class="detail-toolbar">
        <div>
          <h3>Links</h3>
          <span data-detail-complete>${p.completed}/${downloads.length} complete</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="refresh" type="button">Refresh</button>
      </div>
      <div class="detail-progress">
        <div class="progress-track"><div class="progress-fill" data-detail-fill style="width:${Math.min(100, p.pct).toFixed(1)}%"></div></div>
        <div class="game-progress-labels"><span data-detail-downloaded>${fmtBytes(p.downloaded)}</span><span data-detail-total-label>${total}</span></div>
      </div>
      <div class="file-list">
        ${downloads.length ? downloads.map(renderFileRow).join('') : '<div class="empty-state"><p>No links found for this game.</p></div>'}
      </div>
    </div>
  </section>`;
}

function renderFileRow(dl) {
  const pct = dl.total_bytes ? (dl.bytes_downloaded || 0) / dl.total_bytes * 100 : (dl.progress || 0);
  const fillClass = dl.status === 'completed' ? 'done' : dl.status === 'failed' ? 'error' : dl.status === 'paused' ? 'paused' : '';
  const name = dl.filename || dl.url.split('/').pop() || `Download #${dl.id}`;
  const actionLabel = runningStatuses.has(dl.status) ? 'Pause' : dl.status === 'completed' ? 'Done' : 'Start';
  const disabled = dl.status === 'completed' ? 'disabled' : '';
  const showUrl = boolSetting(librarySettings.library_show_file_urls, true);

  return `<div class="file-row" data-dl-id="${dl.id}">
    <span class="badge badge-${esc(dl.status)}" data-file-status>${esc(dl.status)}</span>
    <div class="file-main">
      <div class="file-name" data-file-name title="${esc(name)}">${esc(name)}</div>
      ${showUrl ? `<a class="file-url" href="${esc(dl.url)}" target="_blank" rel="noopener" title="${esc(dl.url)}">${esc(dl.url)}</a>` : ''}
    </div>
    <div class="file-bar"><div class="progress-track"><div class="progress-fill ${fillClass}" data-file-fill style="width:${Math.min(100, pct).toFixed(1)}%"></div></div></div>
    <div class="file-details">
      <span data-file-bytes>${fmtBytes(dl.bytes_downloaded)} / ${fmtBytes(dl.total_bytes, 'Unknown')}</span>
      <span data-file-speed>${dl.speed ? fmtSpeed(dl.speed) : '-'}</span>
    </div>
    <div class="file-actions">
      <button class="btn btn-primary btn-xs" data-action="toggle-file" data-file-action type="button" ${disabled}>${actionLabel}</button>
      <button class="btn btn-danger btn-xs" data-action="delete-file" type="button">Delete</button>
    </div>
    <div class="file-error" data-file-error ${dl.error_message ? '' : 'hidden'}>${esc(dl.error_message || '')}</div>
  </div>`;
}

function initials(name) {
  return String(name || 'ED').split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();
}

function filesFor(listId) {
  return (downloadsByList.get(listId) || []).map(mergedDownload);
}

function progressPct(dl) {
  return dl.total_bytes ? (dl.bytes_downloaded || 0) / dl.total_bytes * 100 : (dl.progress || 0);
}

function statusClass(status) {
  return String(status || 'pending').replace(/[^\w-]/g, '');
}

function fillClassForStatus(status) {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  if (status === 'paused') return 'paused';
  return '';
}

function setGameAction(button, action) {
  if (!button) return;
  button.textContent = action.label;
  button.disabled = action.disabled;
}

function updateLibraryCard(lst) {
  const card = document.querySelector(`.library-card[data-list-id="${lst.id}"]`);
  if (!card) return;

  const downloads = filesFor(lst.id);
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const total = p.total ? fmtBytes(p.total) : (lst.size || 'Unknown size');

  const files = card.querySelector('[data-card-files]');
  const pct = card.querySelector('[data-card-pct]');
  const fill = card.querySelector('[data-card-fill]');
  const chip = card.querySelector('.size-chip');

  if (files) files.textContent = `${p.completed}/${downloads.length} files`;
  if (pct) pct.textContent = `${p.pct.toFixed(0)}%`;
  if (fill) fill.style.width = `${Math.min(100, p.pct).toFixed(1)}%`;
  if (chip) chip.textContent = total;
  setGameAction(card.querySelector('[data-card-action]'), action);
}

function updateFileRow(row, dl) {
  const status = dl.status || 'pending';
  const pct = progressPct(dl);
  const name = dl.filename || dl.url.split('/').pop() || `Download #${dl.id}`;
  const actionLabel = runningStatuses.has(status) ? 'Pause' : status === 'completed' ? 'Done' : 'Start';

  const badge = row.querySelector('[data-file-status]');
  const nameEl = row.querySelector('[data-file-name]');
  const fill = row.querySelector('[data-file-fill]');
  const bytes = row.querySelector('[data-file-bytes]');
  const speed = row.querySelector('[data-file-speed]');
  const action = row.querySelector('[data-file-action]');
  const error = row.querySelector('[data-file-error]');

  if (badge) {
    badge.className = `badge badge-${statusClass(status)}`;
    badge.textContent = status;
  }
  if (nameEl) {
    nameEl.textContent = name;
    nameEl.title = name;
  }
  if (fill) {
    const fillClass = fillClassForStatus(status);
    fill.className = `progress-fill ${fillClass}`.trim();
    fill.style.width = `${Math.min(100, pct).toFixed(1)}%`;
  }
  if (bytes) {
    bytes.textContent = `${fmtBytes(dl.bytes_downloaded)} / ${fmtBytes(dl.total_bytes, 'Unknown')}`;
  }
  if (speed) speed.textContent = dl.speed ? fmtSpeed(dl.speed) : '-';
  if (action) {
    action.textContent = actionLabel;
    action.disabled = status === 'completed';
  }
  if (error) {
    error.textContent = dl.error_message || '';
    error.hidden = !dl.error_message;
  }
}

function updateDetailView(lst) {
  const detail = document.querySelector(`.library-detail[data-list-id="${lst.id}"]`);
  if (!detail) return;

  const downloads = filesFor(lst.id);
  const byId = new Map(downloads.map(d => [d.id, d]));
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const total = p.total ? fmtBytes(p.total) : (lst.size || 'Unknown size');

  const setText = (selector, value) => {
    const el = detail.querySelector(selector);
    if (el) el.textContent = value;
  };

  setText('[data-detail-total]', total);
  setText('[data-detail-files]', `${downloads.length} files`);
  setText('[data-detail-pct]', `${p.pct.toFixed(0)}%`);
  setText('[data-detail-complete]', `${p.completed}/${downloads.length} complete`);
  setText('[data-detail-downloaded]', fmtBytes(p.downloaded));
  setText('[data-detail-total-label]', total);

  const fill = detail.querySelector('[data-detail-fill]');
  if (fill) fill.style.width = `${Math.min(100, p.pct).toFixed(1)}%`;
  setGameAction(detail.querySelector('[data-detail-action]'), action);

  detail.querySelectorAll('.file-row').forEach((row) => {
    const dl = byId.get(Number(row.dataset.dlId));
    if (dl) updateFileRow(row, dl);
  });
}

function refreshLiveProgress() {
  renderStats();
  if (selectedListId) {
    const selected = lists.find(l => l.id === selectedListId);
    if (selected) updateDetailView(selected);
    return;
  }
  lists.forEach(updateLibraryCard);
}

async function startOrResume(dl) {
  if (dl.status === 'paused') return API.req(`/api/downloads/${dl.id}/resume`, 'POST');
  if (startableStatuses.has(dl.status)) return API.req(`/api/downloads/${dl.id}/start`, 'POST');
  return null;
}

async function toggleDownload(dl) {
  if (runningStatuses.has(dl.status)) {
    return API.req(`/api/downloads/${dl.id}/pause`, 'POST');
  }
  return startOrResume(dl);
}

async function toggleGame(listId) {
  const files = filesFor(listId);
  const running = files.filter(d => runningStatuses.has(d.status));
  if (running.length) {
    for (const dl of running) await API.req(`/api/downloads/${dl.id}/pause`, 'POST');
    toast(`Paused ${running.length} file(s)`, 'ok');
    setTimeout(loadLibrary, 500);
    return;
  }

  const actionable = files.filter(d => d.status === 'paused' || startableStatuses.has(d.status));
  if (!actionable.length) {
    toast('No files need starting', 'info');
    return;
  }
  for (const dl of actionable) await startOrResume(dl);
  toast(`Started ${actionable.length} file(s)`, 'ok');
  setTimeout(loadLibrary, 500);
}

function confirmDelete(message) {
  return !boolSetting(librarySettings.confirm_delete, true) || confirm(message);
}

async function handleAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const listEl = el.closest('[data-list-id]');
  const listId = listEl ? Number(listEl.dataset.listId) : selectedListId;
  const row = el.closest('.file-row');

  if (action === 'open-list') {
    selectedListId = listId;
    renderLibrary();
    return;
  }

  e.stopPropagation();

  if (action === 'back') {
    selectedListId = null;
    renderLibrary();
    return;
  }
  if (action === 'refresh') {
    await loadLibrary();
    return;
  }
  if (action === 'toggle-game') {
    await toggleGame(listId);
    return;
  }
  if (action === 'delete-game') {
    if (!confirmDelete('Delete this game and all of its links?')) return;
    const ok = await API.req(`/api/lists/${listId}`, 'DELETE');
    if (ok) {
      selectedListId = null;
      toast('Game removed', 'ok');
      await loadLibrary();
    }
    return;
  }
  if (action === 'toggle-file' && row) {
    const id = Number(row.dataset.dlId);
    const dl = filesFor(listId).find(d => d.id === id);
    if (!dl) return;
    const ok = await toggleDownload(dl);
    if (ok) {
      toast(`${runningStatuses.has(dl.status) ? 'Paused' : 'Started'} 1 file`, 'ok');
      setTimeout(loadLibrary, 500);
    }
    return;
  }
  if (action === 'delete-file' && row) {
    const id = Number(row.dataset.dlId);
    if (!confirmDelete('Delete this link?')) return;
    const ok = await API.req(`/api/downloads/${id}`, 'DELETE');
    if (ok) {
      toast('Link removed', 'ok');
      await loadLibrary();
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadLibrarySettings();
  document.getElementById('refresh-btn').addEventListener('click', loadLibrary);
  document.getElementById('library').addEventListener('click', handleAction);
  document.getElementById('library').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.library-card');
    if (!card) return;
    e.preventDefault();
    selectedListId = Number(card.dataset.listId);
    renderLibrary();
  });
  API.onProgress((msg) => {
    liveById = new Map((msg.data || []).map(d => [d.id, d]));
    if (lists.length) refreshLiveProgress();
  });
  loadLibrary();
});
