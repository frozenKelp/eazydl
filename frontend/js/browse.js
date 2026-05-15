let knownTitles = new Set();
let knownListIds = new Map();
let knownTitlesLoaded = false;
let browseSettings = { ...SETTINGS_DEFAULTS };
let selectedBrowseCard = null;
let currentQuery = '';
let currentPage = 1;
let browseRequestId = 0;

async function refreshKnownTitles() {
  const lists = await API.req('/api/lists');
  if (lists) {
    knownTitles = new Set(lists.map(l => l.name));
    knownListIds = new Map(lists.map(l => [l.name, l.id]));
    knownTitlesLoaded = true;
    updateBrowseSidePanel();
  }
}

async function loadBrowseSettings() {
  browseSettings = await getSettings();
  applyInterfaceSettings(browseSettings);
  updateBrowseSidePanel();
}

function browseLimit() {
  return Math.max(6, Math.min(60, Number(browseSettings.browse_items_per_page || 24)));
}

async function loadBrowse(query = currentQuery, page = currentPage) {
  const requestId = ++browseRequestId;
  currentQuery = query;
  currentPage = Math.max(1, page);

  const root = document.getElementById('browse-results');
  root.innerHTML = `<div class="loading"><span class="spinner"></span> ${query ? 'Searching' : 'Loading popular this year'}...</div>`;
  clearBrowseDetail();

  if (!knownTitlesLoaded) await refreshKnownTitles();
  const params = new URLSearchParams({
    query,
    page: String(currentPage),
    limit: String(browseLimit()),
    hydrate: 'false',
  });
  const data = await API.req(`/api/scrape/search?${params.toString()}`, 'GET', null, { timeoutMs: 22000 });
  if (requestId !== browseRequestId) return;
  if (!data) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">Offline</div>
        <h3>Could not load Browse</h3>
        <p>Check the server log or try again in a moment.</p>
        <button id="retry-browse" class="btn btn-primary" type="button">Retry</button>
      </div>`;
    document.getElementById('retry-browse')?.addEventListener('click', () => loadBrowse(currentQuery, currentPage));
    return;
  }

  const games = data.games || [];
  if (!games.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">Search</div>
        <h3>No games found</h3>
        <p>Try another search or return to Popular This Year.</p>
      </div>
      ${renderPager(false)}`;
    bindPager(games.length);
    return;
  }

  const sizeClass = `card-size-${browseSettings.browse_card_size || 'medium'}`;
  root.innerHTML = `
    <div class="results-toolbar">
      <span>${query ? 'Search results' : 'Popular this year'}</span>
      <span>Page ${currentPage}</span>
    </div>
    <div class="browse-grid ${sizeClass}">
      ${games.map(renderBrowseCard).join('')}
    </div>
    ${renderPager(games.length >= browseLimit())}`;
  clearBrowseDetail();
  bindPager(games.length);
  updateBrowseSidePanel(games.length);
}

function renderBrowseStart() {
  const root = document.getElementById('browse-results');
  clearBrowseDetail();
  root.innerHTML = `
    <div class="empty-state empty-state-tight">
      <div class="empty-icon"><span class="icon icon-browse" aria-hidden="true"></span></div>
      <h3>Search FitGirl</h3>
      <p>Enter a title above, or use Popular when you want to fetch the yearly index.</p>
    </div>`;
}

function renderPager(hasNext) {
  return `
    <div class="pager">
      <button id="prev-page" class="btn btn-ghost btn-sm" type="button" ${currentPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="pager-count">Page ${currentPage}</span>
      <button id="next-page" class="btn btn-ghost btn-sm" type="button" ${hasNext ? '' : 'disabled'}>Next</button>
    </div>`;
}

function bindPager(count) {
  const prev = document.getElementById('prev-page');
  const next = document.getElementById('next-page');
  if (prev) prev.addEventListener('click', () => loadBrowse(currentQuery, currentPage - 1));
  if (next) next.addEventListener('click', () => loadBrowse(currentQuery, currentPage + 1));
  if (count < browseLimit() && currentPage > 1 && next) next.disabled = true;
}

function proxiedImage(url) {
  if (!url) return '';
  return `/api/image?url=${encodeURIComponent(url)}`;
}

function categoryString(categories) {
  return Array.isArray(categories) ? categories.filter(Boolean).join('|') : '';
}

function renderBrowseCard(game) {
  const title = String(game.title || '').trim();
  const inLibrary = knownTitles.has(title);
  const libraryId = knownListIds.get(title) || '';
  const image = proxiedImage(game.image);
  const size = game.size ? String(game.size).replace(/^from\s+/i, '') : '';
  const cats = Array.isArray(game.categories) ? game.categories.filter(Boolean).slice(0, 3) : [];
  return `<article class="browse-card" tabindex="0" role="button"
      data-title="${esc(title)}"
      data-url="${esc(game.url)}"
      data-image-url="${esc(game.image || '')}"
      data-size="${esc(size)}"
      data-categories="${esc(cats.join('|'))}"
      data-library-id="${esc(libraryId)}">
    <div class="browse-thumb-wrap">
      ${image
        ? `<img class="browse-thumb is-loading" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.remove('is-loading')" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'browse-thumb-placeholder',textContent:'No image'}))">`
        : '<div class="browse-thumb-placeholder">No image</div>'}
      ${size ? `<span class="size-chip">${esc(size)}</span>` : ''}
    </div>
    <div class="browse-card-body">
      <h2 class="browse-card-title" title="${esc(title)}">${esc(title)}</h2>
      <div class="card-tags">${cats.map(c => `<span class="tag-chip">${esc(c)}</span>`).join('')}</div>
      <div class="browse-card-actions">
        ${inLibrary
          ? `<button class="btn btn-library btn-sm" data-action="view-library" type="button">In library</button>`
          : '<button class="btn btn-primary btn-sm" data-action="add" type="button">Add</button>'}
      </div>
    </div>
  </article>`;
}

function openBrowseLibrary(card) {
  const libraryId = card.dataset.libraryId;
  if (!libraryId) return;
  window.location.href = `/library?listId=${encodeURIComponent(libraryId)}`;
}

async function openBrowseCard(card) {
  selectedBrowseCard = card;
  if (card.dataset.libraryId) {
    openBrowseLibrary(card);
    return;
  }
  document.querySelectorAll('.browse-card.selected').forEach(el => el.classList.remove('selected'));
  card.classList.add('selected');
  renderBrowseDetail(card);
}

function clearBrowseDetail() {
  selectedBrowseCard = null;
  const detailPanel = document.getElementById('browse-detail-panel');
  document.querySelectorAll('.browse-card.selected').forEach(el => el.classList.remove('selected'));
  if (!detailPanel) return;
  detailPanel.innerHTML = `
    <div class="mini-title">Selected</div>
    <div class="mini-list">
      <div class="mini-row"><span>Click a card to inspect it</span></div>
    </div>`;
}

function renderBrowseDetail(card) {
  const detailPanel = document.getElementById('browse-detail-panel');
  if (!detailPanel) return;
  const title = card.dataset.title;
  const image = card.dataset.imageUrl ? proxiedImage(card.dataset.imageUrl) : '';
  const size = card.dataset.size || 'Unknown size';
  const categories = (card.dataset.categories || '').split('|').filter(Boolean);
  const inLibrary = Boolean(card.dataset.libraryId);
  const target = boolSetting(browseSettings.browse_open_links_new_tab, true) ? ' target="_blank" rel="noopener"' : '';
  detailPanel.innerHTML = `
    <div class="mini-title">Selected</div>
    <div class="browse-detail-card">
      <div class="browse-detail-cover">
        ${image ? `<img src="${esc(image)}" alt="${esc(title)}" loading="lazy" referrerpolicy="no-referrer">` : '<div class="browse-cover-placeholder">No image</div>'}
      </div>
      <h3 class="browse-detail-title" title="${esc(title)}">${esc(title)}</h3>
      <div class="card-tags">${categories.map(c => `<span class="tag-chip">${esc(c)}</span>`).join('')}</div>
      <div class="browse-detail-meta"><span>${esc(size)}</span></div>
      <div class="browse-card-actions">
        <a class="btn btn-ghost btn-sm" href="${esc(card.dataset.url)}"${target}>FitGirl page</a>
        ${inLibrary
          ? `<button class="btn btn-library btn-sm" data-action="view-library" type="button">Open library</button>`
          : '<button class="btn btn-primary btn-sm" data-action="add" type="button">Add</button>'}
      </div>
    </div>`;
}

function updateBrowseCardLibraryState(card, libraryId) {
  card.dataset.libraryId = String(libraryId);
  card.querySelectorAll('button[data-action="add"]').forEach((btn) => {
    btn.outerHTML = '<button class="btn btn-library btn-sm" data-action="view-library" type="button">In library</button>';
  });
  if (selectedBrowseCard === card) renderBrowseDetail(card);
}

async function addCard(card, button) {
  const title = card.dataset.title;
  const gameUrl = card.dataset.url;
  button.disabled = true;
  button.textContent = 'Scraping...';
  const res = await API.req('/api/games', 'POST', {
    title,
    game_url: gameUrl,
    image_url: card.dataset.imageUrl || '',
    size: card.dataset.size || '',
    categories: (card.dataset.categories || '').split('|').filter(Boolean),
  });
  if (!res) {
    button.disabled = false;
    button.textContent = 'Add';
    return;
  }
  knownTitles.add(title);
  knownListIds.set(title, res.id);
  toast(`Added ${res.added} of ${res.found} link(s) for ${title}`, 'ok');
  setText('browse-last-add', `${res.added}/${res.found}`);
  updateBrowseCardLibraryState(card, res.id);

  if (boolSetting(browseSettings.auto_start_new_games)) {
    const ids = Array.isArray(res.download_ids) ? res.download_ids.map(Number).filter(Boolean) : [];
    if (ids.length) {
      const ok = await API.req('/api/downloads/batch/start', 'POST', { ids });
      if (ok) toast(`Queued ${Number(ok.queued || 0)} file(s)`, 'ok');
    }
  }
  updateBrowseSidePanel();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateBrowseSidePanel(resultCount = null) {
  setText('browse-known-count', String(knownTitles.size));
  setText('browse-auto-start', boolSetting(browseSettings.auto_start_new_games) ? 'on' : 'off');
  setText('browse-side-page', resultCount === null ? String(currentPage) : `${currentPage} (${resultCount})`);
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const popular = document.getElementById('popular-btn');
  const root = document.getElementById('browse-results');

  await loadBrowseSettings();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadBrowse(input.value.trim(), 1);
  });

  popular.addEventListener('click', () => {
    input.value = '';
    loadBrowse('', 1);
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      const action = btn.dataset.action;
      const card = btn.closest('.browse-card');
      if (!card) return;
      if (action === 'add') {
        addCard(card, btn);
        return;
      }
      if (action === 'view-library') {
        openBrowseLibrary(card);
        return;
      }
      return;
    }
    const card = e.target.closest('.browse-card');
    if (!card) return;
    openBrowseCard(card);
  });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('button, a')) return;
    const card = e.target.closest('.browse-card');
    if (!card) return;
    e.preventDefault();
    openBrowseCard(card);
  });

  const detailPanel = document.getElementById('browse-detail-panel');
  if (detailPanel) {
    detailPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || !selectedBrowseCard) return;
      if (btn.dataset.action === 'add') {
        addCard(selectedBrowseCard, btn);
      }
      if (btn.dataset.action === 'view-library') {
        openBrowseLibrary(selectedBrowseCard);
      }
    });
  }

  clearBrowseDetail();
  renderBrowseStart();
});
