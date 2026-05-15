let lists = [];
let downloadsByList = new Map();
let liveById = new Map();
let selectedListId = null;
let librarySettings = { ...SETTINGS_DEFAULTS };
let libraryScrollY = 0;
let loadingLibrary = false;
let libraryFilter = '';

function getInitialSelectedListId() {
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get('listId'));
  return Number.isInteger(id) && id > 0 ? id : null;
}

const runningStatuses = new Set(['downloading', 'queued']);
const startableStatuses = new Set(['pending', 'failed']);

function mergedDownload(dl) {
  const live = liveById.get(dl.id) || {};
  return {
    ...dl,
    ...live,
    url: dl.url,
    filename: live.filename || dl.filename || '',
    status: live.status || dl.status,
    error_message: live.error || live.error_message || dl.error_message || '',
  };
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
  if (loadingLibrary) return;
  loadingLibrary = true;
  const root = document.getElementById('library');
  root.innerHTML = '<div class="loading"><span class="spinner"></span> Loading library...</div>';
  const data = await API.req('/api/library');
  loadingLibrary = false;
  if (!data) return;
  lists = data.lists || [];
  downloadsByList = new Map();
  lists.forEach((lst) => downloadsByList.set(lst.id, lst.downloads || []));

  if (!selectedListId) selectedListId = getInitialSelectedListId();
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
  if (!downloads.length) return { pct: 0, downloaded: 0, total: 0, completed: 0, allSized: false };
  const merged = downloads.map(mergedDownload);
  const total = merged.reduce((s, d) => s + (d.total_bytes || 0), 0);
  const downloaded = merged.reduce((s, d) => s + (d.bytes_downloaded || 0), 0);
  const completed = merged.filter(d => d.status === 'completed').length;
  const allSized = merged.every(d => d.total_bytes > 0);
  const pct = total ? downloaded / total * 100 : 0;
  return { pct, downloaded, total, completed, allSized };
}

function gameAction(downloads) {
  const merged = downloads.map(mergedDownload);
  if (!window.aria2Online && merged.some(d => d.status !== 'completed')) return { label: 'Offline', disabled: true };
  if (merged.some(d => runningStatuses.has(d.status))) return { label: 'Pause', disabled: false };
  if (merged.some(d => d.status === 'failed')) return { label: 'Retry', disabled: false };
  if (merged.some(d => d.status === 'paused')) return { label: 'Resume', disabled: false };
  if (merged.some(d => startableStatuses.has(d.status))) return { label: 'Start', disabled: false };
  return { label: 'Done', disabled: true };
}

function gameDisplaySize(lst, progress) {
  if (lst.size) return String(lst.size).replace(/^from\s+/i, '');
  if (progress.allSized && progress.total) return fmtBytes(progress.total);
  if (progress.total) return `Known ${fmtBytes(progress.total)}`;
  return 'Unknown size';
}

function renderLibrary() {
  renderStats();
  const root = document.getElementById('library');
  if (!lists.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><span class="icon icon-library" aria-hidden="true"></span></div>
        <h3>No games in your library</h3>
        <p>Add a repack from Browse to see it here.</p>
      </div>`;
    updateLibrarySidePanel(0);
    return;
  }

  if (selectedListId) {
    const selected = lists.find(l => l.id === selectedListId);
    if (selected) {
      root.innerHTML = renderDetail(selected);
      updateLibrarySidePanel(1, selected.name);
      return;
    }
  }

  const visible = libraryFilter
    ? lists.filter(lst => String(lst.name || '').toLowerCase().includes(libraryFilter))
    : lists;
  if (!visible.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><span class="icon icon-browse" aria-hidden="true"></span></div>
        <h3>No matching games</h3>
        <p>Clear the library filter to show everything.</p>
      </div>`;
    updateLibrarySidePanel(0);
    return;
  }
  const sizeClass = `card-size-${librarySettings.library_card_size || 'medium'}`;
  root.innerHTML = `<div class="library-grid ${sizeClass}">${visible.map(renderLibraryCard).join('')}</div>`;
  updateLibrarySidePanel(visible.length);
}

function renderLibraryCard(lst) {
  const downloads = (downloadsByList.get(lst.id) || []).map(mergedDownload);
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const image = proxiedImage(lst.image_url);
  const total = gameDisplaySize(lst, p);
  const cats = (lst.categories || []).slice(0, 3);

  return `<article class="library-card" data-action="open-list" data-list-id="${lst.id}" tabindex="0">
    <div class="library-cover-wrap">
      ${image
        ? `<img class="library-cover" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<div class="library-cover-placeholder">${esc(initials(lst.name))}</div>`}
      <span class="size-chip">${esc(total)}</span>
    </div>
    <div class="library-card-body">
      <h2 class="library-card-title" title="${esc(lst.name)}">${esc(lst.name)}</h2>
      <div class="card-tags">${cats.map(c => `<span class="tag-chip">${esc(c)}</span>`).join('')}</div>
      <div class="library-card-meta">
        <span data-card-files>${p.completed}/${downloads.length} files</span>
        <span data-card-pct>${p.pct.toFixed(0)}%</span>
      </div>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, p.pct).toFixed(0)}"><div class="progress-fill" data-card-fill style="width:${Math.min(100, p.pct).toFixed(1)}%"></div></div>
      <div class="library-card-actions">
        <button class="btn btn-primary btn-sm" data-action="toggle-game" data-card-action type="button" ${action.disabled ? 'disabled' : ''}>${action.label}</button>
      </div>
    </div>
  </article>`;
}

function naturalSort(a, b) {
  const nameA = (a.filename || a.url.split('/').pop() || '').toLowerCase();
  const nameB = (b.filename || b.url.split('/').pop() || '').toLowerCase();
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

function renderDetail(lst) {
  const downloads = (downloadsByList.get(lst.id) || [])
    .map(mergedDownload)
    .sort(naturalSort);
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const image = proxiedImage(lst.image_url);
  const cats = (lst.categories || []).slice(0, 6);
  const total = gameDisplaySize(lst, p);

  return `<section class="library-detail" data-list-id="${lst.id}">
    <aside class="detail-side">
      <button class="back-link" data-action="back" type="button">&lt; Back</button>
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
        <div class="detail-toolbar-actions">
          <button class="btn btn-primary btn-sm" data-action="toggle-game" data-detail-toolbar-action type="button" ${action.disabled ? 'disabled' : ''}>${action.label} All</button>
          <button class="btn btn-ghost btn-sm" data-action="refresh" type="button">Refresh</button>
        </div>
      </div>
      <div class="detail-progress">
        <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, p.pct).toFixed(0)}"><div class="progress-fill" data-detail-fill style="width:${Math.min(100, p.pct).toFixed(1)}%"></div></div>
        <div class="game-progress-labels"><span data-detail-downloaded>${fmtBytes(p.downloaded)}</span><span data-detail-total-label>${total}</span></div>
      </div>
      <div class="file-list">
        ${downloads.length ? `
          <div class="file-head">
            <span>Status</span>
            <span>Name</span>
            <span>Progress</span>
            <span>Transfer</span>
            <span>Actions</span>
          </div>
          ${downloads.map(renderFileRow).join('')}` : '<div class="empty-state"><p>No links found for this game.</p></div>'}
      </div>
    </div>
  </section>`;
}

function renderFileRow(dl) {
  const pct = dl.total_bytes ? (dl.bytes_downloaded || 0) / dl.total_bytes * 100 : (dl.progress || 0);
  const fillClass = dl.status === 'completed' ? 'done' : dl.status === 'failed' ? 'error' : dl.status === 'paused' ? 'paused' : '';
  const name = dl.filename || dl.url.split('/').pop() || `Download #${dl.id}`;
  const actionLabel = runningStatuses.has(dl.status)
    ? 'Pause'
    : dl.status === 'completed'
      ? 'Done'
      : dl.status === 'paused'
        ? 'Resume'
        : dl.status === 'failed'
          ? 'Retry'
          : 'Start';
  const disabled = dl.status === 'completed' || !window.aria2Online ? 'disabled' : '';
  const showUrl = boolSetting(librarySettings.library_show_file_urls, true);

  return `<div class="file-row" data-dl-id="${dl.id}" aria-live="polite">
    <span class="badge badge-${esc(dl.status)}" data-file-status data-label="Status">${esc(dl.status)}</span>
    <div class="file-main" data-label="Name">
      <div class="file-name" data-file-name title="${esc(name)}">${esc(name)}</div>
      ${showUrl ? `<button class="file-url file-url-button" data-action="open-file-url" data-url="${esc(dl.url)}" type="button" title="Open source link">${esc(dl.url)}</button>` : ''}
    </div>
    <div class="file-bar" data-label="Progress"><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct).toFixed(0)}"><div class="progress-fill ${fillClass}" data-file-fill style="width:${Math.min(100, pct).toFixed(1)}%"></div></div></div>
    <div class="file-details" data-label="Transfer">
      <span data-file-bytes>${fmtBytes(dl.bytes_downloaded)} / ${fmtBytes(dl.total_bytes, 'Unknown')}</span>
      <span data-file-speed>${dl.speed ? fmtSpeed(dl.speed) : '-'}</span>
    </div>
    <div class="file-actions" data-label="Actions">
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

function patchDownloads(ids, patch) {
  const wanted = new Set(ids);
  downloadsByList.forEach((rows) => {
    rows.forEach((row) => {
      if (wanted.has(row.id)) Object.assign(row, patch);
    });
  });
}

function batchIds(res, key, fallbackIds = []) {
  if (!res) return [];
  if (Array.isArray(res[key])) {
    return res[key].map(Number).filter(id => Number.isInteger(id) && id > 0);
  }
  return [];
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

function setToolbarAction(button, action) {
  if (!button) return;
  button.textContent = `${action.label} All`;
  button.disabled = action.disabled;
}

function patchForToggleResponse(dl, res) {
  if (!res) return null;
  if (res.status === 'paused') {
    return { status: 'paused', speed: 0 };
  }
  if (res.status === 'reset') {
    return { status: 'pending', bytes_downloaded: 0, speed: 0, error_message: res.error || '' };
  }
  if (['queued', 'resumed', 'already_running'].includes(res.status)) {
    return { status: 'queued', error_message: '' };
  }
  if (runningStatuses.has(dl.status)) {
    return { status: 'paused', speed: 0 };
  }
  return { status: 'queued', error_message: '' };
}

function updateLibraryCard(lst) {
  const card = document.querySelector(`.library-card[data-list-id="${lst.id}"]`);
  if (!card) return;

  const downloads = filesFor(lst.id);
  const p = gameProgress(downloads);
  const action = gameAction(downloads);
  const total = gameDisplaySize(lst, p);

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
  const actionLabel = runningStatuses.has(status)
    ? 'Pause'
    : status === 'completed'
      ? 'Done'
      : status === 'paused'
        ? 'Resume'
        : status === 'failed'
          ? 'Retry'
          : 'Start';

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
    const next = Math.min(100, pct);
    fill.style.width = `${next.toFixed(1)}%`;
    fill.closest('.progress-track')?.setAttribute('aria-valuenow', String(next.toFixed(0)));
  }
  if (bytes) {
    bytes.textContent = `${fmtBytes(dl.bytes_downloaded)} / ${fmtBytes(dl.total_bytes, 'Unknown')}`;
  }
  if (speed) speed.textContent = dl.speed ? fmtSpeed(dl.speed) : '-';
  if (action) {
    action.textContent = actionLabel;
    action.disabled = status === 'completed' || !window.aria2Online;
    action.title = !window.aria2Online && status !== 'completed' ? 'aria2c is offline' : '';
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
  const total = gameDisplaySize(lst, p);

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
  if (fill) {
    fill.style.width = `${Math.min(100, p.pct).toFixed(1)}%`;
    fill.closest('.progress-track')?.setAttribute('aria-valuenow', String(Math.min(100, p.pct).toFixed(0)));
  }
  setGameAction(detail.querySelector('[data-detail-action]'), action);
  setToolbarAction(detail.querySelector('[data-detail-toolbar-action]'), action);

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

function setSideText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateLibrarySidePanel(visibleCount = null, selectedName = '') {
  const visible = visibleCount ?? (libraryFilter
    ? lists.filter(lst => String(lst.name || '').toLowerCase().includes(libraryFilter)).length
    : lists.length);
  setSideText('library-visible-count', String(visible));
  setSideText('library-selected-name', selectedName || (selectedListId ? 'selected' : 'none'));
  setSideText('library-filter-state', libraryFilter ? 'on' : 'off');
}

function updateLibraryRuntime(aria2Ok, downloads = []) {
  const total = downloads.reduce((s, d) => s + (d.speed || 0), 0);
  const active = downloads.filter(d => runningStatuses.has(d.status)).length;
  setSideText('library-runtime-aria', aria2Ok ? (active ? `${active} active` : 'idle') : 'offline');
  setSideText('library-runtime-speed', fmtSpeed(total));
}

async function toggleGame(listId) {
  const files = filesFor(listId);
  const running = files.filter(d => runningStatuses.has(d.status));
  if (running.length) {
    const ids = running.map(d => d.id);
    const ok = await API.req('/api/downloads/batch/pause', 'POST', { ids });
    if (ok) {
      patchDownloads(ids, { status: 'paused', speed: 0 });
      refreshLiveProgress();
      toast(`Paused ${running.length} file(s)`, 'ok');
    }
    return;
  }

  const paused = files.filter(d => d.status === 'paused');
  const startable = files.filter(d => startableStatuses.has(d.status));
  const actionable = [...paused, ...startable];
  if (!actionable.length) {
    toast('No files need starting', 'info');
    return;
  }
  let queued = 0;
  let resumed = 0;
  let reset = 0;
  let skipped = 0;
  if (paused.length) {
    const ids = paused.map(d => d.id);
    const res = await API.req('/api/downloads/batch/resume', 'POST', { ids });
    if (res) {
      const resumedIds = batchIds(res, 'resumed_ids', ids);
      const queuedIds = batchIds(res, 'queued_ids', ids);
      const resetIds = batchIds(res, 'reset_ids', ids);
      if (resumedIds.length) {
        patchDownloads(resumedIds, { status: 'queued', error_message: '' });
        resumed += resumedIds.length;
      }
      if (queuedIds.length) {
        patchDownloads(queuedIds, { status: 'queued', error_message: '' });
        queued += queuedIds.length;
      }
      if (resetIds.length) {
        patchDownloads(resetIds, { status: 'pending', bytes_downloaded: 0, speed: 0 });
        reset += resetIds.length;
      }
      skipped += Number(res.skipped || 0);
    }
  }
  if (startable.length) {
    const ids = startable.map(d => d.id);
    const res = await API.req('/api/downloads/batch/start', 'POST', { ids });
    if (res) {
      const queuedIds = batchIds(res, 'queued_ids', ids);
      if (queuedIds.length) {
        patchDownloads(queuedIds, { status: 'queued', error_message: '' });
        queued += queuedIds.length;
      }
      skipped += Number(res.skipped || 0);
    }
  }
  refreshLiveProgress();
  const messageParts = [];
  if (resumed) messageParts.push(`${resumed} resumed`);
  if (queued) messageParts.push(`${queued} queued`);
  if (reset) messageParts.push(`${reset} reset`);
  if (skipped && !messageParts.length) messageParts.push(`${skipped} skipped`);
  toast(messageParts.length ? messageParts.join(' and ') : `Queued ${actionable.length} file(s)`, 'ok');
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
    libraryScrollY = window.scrollY;
    renderLibrary();
    return;
  }

  e.stopPropagation();

  if (action === 'back') {
    selectedListId = null;
    renderLibrary();
    requestAnimationFrame(() => window.scrollTo(0, libraryScrollY));
    return;
  }
  if (action === 'refresh') {
    await loadLibrary();
    return;
  }
  if (action === 'open-file-url') {
    window.open(el.dataset.url, '_blank', 'noopener');
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
      const patch = patchForToggleResponse(dl, ok);
      if (patch) patchDownloads([id], patch);
      refreshLiveProgress();
      const label = patch?.status === 'paused' ? 'Paused' : patch?.status === 'pending' ? 'Reset' : 'Queued';
      toast(`${label} 1 file`, 'ok');
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
  document.getElementById('library-filter')?.addEventListener('input', (e) => {
    libraryFilter = e.target.value.trim().toLowerCase();
    if (!selectedListId) renderLibrary();
  });
  document.getElementById('library').addEventListener('click', handleAction);
  document.getElementById('library').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button, a')) return;
    const card = e.target.closest('.library-card');
    if (!card) return;
    e.preventDefault();
    selectedListId = Number(card.dataset.listId);
    renderLibrary();
  });
  API.onProgress((msg) => {
    liveById = new Map((msg.data || []).map(d => [d.id, d]));
    updateLibraryRuntime(msg.aria2_ok, msg.data || []);
    if (lists.length) refreshLiveProgress();
  });
  loadLibrary();
  API.req('/api/status').then(status => {
    if (status) updateLibraryRuntime(status.aria2_running, []);
  });
});
