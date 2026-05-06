let lists = [];
const openLists = new Set();
const downloadsByList = new Map();
let liveById = new Map();

const statusOrder = ['downloading', 'queued', 'paused', 'failed', 'pending', 'completed'];

function mergedDownload(dl) {
  const live = liveById.get(dl.id) || {};
  return { ...dl, ...live, status: live.status || dl.status };
}

async function loadLibrary() {
  const root = document.getElementById('library');
  root.innerHTML = '<div class="loading"><span class="spinner"></span> Loading library…</div>';
  const data = await API.req('/api/lists');
  if (!data) return;
  lists = data;
  await Promise.all(lists.map(async (lst) => {
    const dls = await API.req(`/api/lists/${lst.id}/downloads`);
    if (dls) downloadsByList.set(lst.id, dls);
  }));
  renderLibrary();
}

function renderStats() {
  const stats = document.getElementById('library-stats');
  const gameCount = lists.length;
  const files = [...downloadsByList.values()].flat().map(mergedDownload);
  const running = files.filter(d => ['downloading', 'queued'].includes(d.status)).length;
  const done = files.filter(d => d.status === 'completed').length;
  const totalBytes = files.reduce((s, d) => s + (d.total_bytes || 0), 0);
  stats.innerHTML = `
    <div class="stat-card"><strong>${gameCount}</strong><span>Games</span></div>
    <div class="stat-card"><strong>${files.length}</strong><span>Files</span></div>
    <div class="stat-card"><strong>${done}</strong><span>Completed</span></div>
    <div class="stat-card"><strong>${running}</strong><span>Running</span></div>
    <div class="stat-card"><strong>${fmtBytes(totalBytes)}</strong><span>Known size</span></div>`;
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

function renderLibrary() {
  renderStats();
  const root = document.getElementById('library');
  if (!lists.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">☰</div><h3>No games in your library</h3><p>Go to <a href="/browse">Browse</a>, search for a game, and press Add to Library.</p></div>`;
    return;
  }
  root.innerHTML = lists.map(renderGameCard).join('');
}

function renderGameCard(lst) {
  const downloads = (downloadsByList.get(lst.id) || []).map(mergedDownload)
    .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  const p = gameProgress(downloads);
  const isOpen = openLists.has(lst.id);
  return `<article class="game-card" data-list-id="${lst.id}" data-open="${isOpen}">
    <div class="game-header" role="button" tabindex="0" data-action="toggle">
      <span class="game-toggle">▶</span>
      <h2 class="game-title" title="${esc(lst.name)}">${esc(lst.name)}</h2>
      <div class="game-meta">
        <span>${p.completed}/${downloads.length} files</span>
        <span>${fmtBytes(p.downloaded)} / ${fmtBytes(p.total)}</span>
      </div>
      <div class="game-actions">
        <button class="btn btn-primary btn-xs" data-action="start-game" type="button">Start</button>
        <button class="btn btn-ghost btn-xs" data-action="pause-game" type="button">Pause</button>
        <button class="btn btn-ghost btn-xs" data-action="stop-game" type="button">Stop</button>
        <button class="btn btn-danger btn-xs" data-action="delete-game" type="button">Delete</button>
      </div>
    </div>
    <div class="game-progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, p.pct).toFixed(1)}%"></div></div>
      <div class="game-progress-labels"><span>${p.pct.toFixed(1)}%</span><span>${downloads.length || 'No'} links</span></div>
    </div>
    <div class="game-body ${isOpen ? 'open' : ''}">
      ${downloads.length ? downloads.map(renderFileRow).join('') : '<div class="empty-state"><p>No links found for this game.</p></div>'}
    </div>
  </article>`;
}

function renderFileRow(dl) {
  const pct = dl.total_bytes ? (dl.bytes_downloaded || 0) / dl.total_bytes * 100 : (dl.progress || 0);
  const fillClass = dl.status === 'completed' ? 'done' : dl.status === 'failed' ? 'error' : dl.status === 'paused' ? 'paused' : '';
  const name = dl.filename || dl.url.split('/').pop() || `Download #${dl.id}`;
  const canResume = dl.status === 'paused';
  return `<div class="file-row" data-dl-id="${dl.id}">
    <span class="badge badge-${esc(dl.status)}">${esc(dl.status)}</span>
    <div class="file-main"><div class="file-name" title="${esc(name)}">${esc(name)}</div><div class="file-url" title="${esc(dl.url)}">${esc(dl.url)}</div></div>
    <div class="file-bar"><div class="progress-track"><div class="progress-fill ${fillClass}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div></div>
    <div class="file-details"><span class="file-size">${fmtBytes(dl.bytes_downloaded)} / ${fmtBytes(dl.total_bytes)}</span><span class="file-speed">${dl.speed ? fmtSpeed(dl.speed) : '—'}</span></div>
    <div class="file-actions">
      <button class="btn btn-primary btn-xs" data-action="${canResume ? 'resume-file' : 'start-file'}" type="button">${canResume ? 'Resume' : 'Start'}</button>
      <button class="btn btn-ghost btn-xs" data-action="pause-file" type="button">Pause</button>
      <button class="btn btn-ghost btn-xs" data-action="stop-file" type="button">Stop</button>
      <button class="btn btn-danger btn-xs" data-action="delete-file" type="button">✕</button>
    </div>
    ${dl.error_message ? `<div class="file-error">${esc(dl.error_message)}</div>` : ''}
  </div>`;
}

async function operateDownloads(ids, op) {
  ids = ids.filter(Boolean);
  if (!ids.length) {
    toast('No matching files for that action', 'info');
    return;
  }
  for (const id of ids) await API.req(`/api/downloads/${id}/${op}`, 'POST');
  toast(`${op[0].toUpperCase() + op.slice(1)} sent for ${ids.length} file(s)`, 'ok');
  setTimeout(loadLibrary, 500);
}

async function handleClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const card = btn.closest('.game-card');
  const row = btn.closest('.file-row');
  const listId = card ? Number(card.dataset.listId) : null;
  if (action === 'toggle') {
    if (e.target.closest('button')) return;
    openLists.has(listId) ? openLists.delete(listId) : openLists.add(listId);
    renderLibrary();
    return;
  }
  e.stopPropagation();
  const files = downloadsByList.get(listId) || [];
  const ids = row ? [Number(row.dataset.dlId)] : files.map(d => d.id);
  if (action === 'start-game') {
    const merged = files.map(mergedDownload);
    const paused = merged.filter(d => d.status === 'paused').map(d => d.id);
    const startable = merged.filter(d => ['pending', 'failed'].includes(d.status)).map(d => d.id);
    if (!paused.length && !startable.length) return toast('No files need starting', 'info');
    for (const id of paused) await API.req(`/api/downloads/${id}/resume`, 'POST');
    for (const id of startable) await API.req(`/api/downloads/${id}/start`, 'POST');
    toast(`Start sent for ${paused.length + startable.length} file(s)`, 'ok');
    setTimeout(loadLibrary, 500);
    return;
  }
  if (action === 'pause-game') return operateDownloads(ids.filter(Boolean), 'pause');
  if (action === 'stop-game') return operateDownloads(ids.filter(Boolean), 'stop');
  if (action === 'delete-game') {
    if (!confirm('Delete this game and all its links from the library?')) return;
    const ok = await API.req(`/api/lists/${listId}`, 'DELETE');
    if (ok) { toast('Game removed', 'ok'); await loadLibrary(); }
    return;
  }
  if (action === 'start-file') return operateDownloads(ids, 'start');
  if (action === 'resume-file') return operateDownloads(ids, 'resume');
  if (action === 'pause-file') return operateDownloads(ids, 'pause');
  if (action === 'stop-file') return operateDownloads(ids, 'stop');
  if (action === 'delete-file') {
    if (!confirm('Delete this link?')) return;
    const ok = await API.req(`/api/downloads/${ids[0]}`, 'DELETE');
    if (ok) { toast('Link removed', 'ok'); await loadLibrary(); }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-btn').addEventListener('click', loadLibrary);
  document.getElementById('library').addEventListener('click', handleClick);
  API.onProgress((msg) => {
    liveById = new Map((msg.data || []).map(d => [d.id, d]));
    if (lists.length) renderLibrary();
  });
  loadLibrary();
});
