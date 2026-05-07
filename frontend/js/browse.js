let knownTitles = new Set();
let knownTitlesLoaded = false;
let browseSettings = { ...SETTINGS_DEFAULTS };
let currentQuery = '';
let currentPage = 1;
let browseRequestId = 0;

async function refreshKnownTitles() {
  const lists = await API.req('/api/lists');
  if (lists) {
    knownTitles = new Set(lists.map(l => l.name));
    knownTitlesLoaded = true;
  }
}

async function loadBrowseSettings() {
  browseSettings = await getSettings();
  applyInterfaceSettings(browseSettings);
}

function browseLimit() {
  return Math.max(6, Math.min(60, Number(browseSettings.browse_items_per_page || 24)));
}

async function loadBrowse(query = currentQuery, page = currentPage) {
  const requestId = ++browseRequestId;
  currentQuery = query;
  currentPage = Math.max(1, page);

  const root = document.getElementById('browse-results');
  root.innerHTML = `<div class="loading"><span class="spinner"></span> ${query ? 'Searching and loading details' : 'Loading popular this year, covers, and sizes'}...</div>`;

  if (!knownTitlesLoaded) await refreshKnownTitles();
  const params = new URLSearchParams({
    query,
    page: String(currentPage),
    limit: String(browseLimit()),
  });
  const data = await API.req(`/api/scrape/search?${params.toString()}`);
  if (requestId !== browseRequestId) return;
  if (!data) return;

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
  const descriptions = boolSetting(browseSettings.browse_show_descriptions, true) ? '' : ' hide-descriptions';
  root.innerHTML = `
    <div class="results-toolbar">
      <span>${query ? 'Search results' : 'Popular this year'}</span>
      <span>Page ${currentPage}</span>
    </div>
    <div class="browse-grid ${sizeClass}${descriptions}">
      ${games.map(renderBrowseCard).join('')}
    </div>
    ${renderPager(games.length >= browseLimit())}`;
  bindPager(games.length);
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
  const inLibrary = knownTitles.has(game.title);
  const image = proxiedImage(game.image);
  const size = game.size ? String(game.size).replace(/^from\s+/i, '') : '';
  const categories = categoryString(game.categories);
  const openTarget = boolSetting(browseSettings.browse_open_links_new_tab, true)
    ? 'target="_blank" rel="noopener"'
    : '';
  return `<article class="browse-card"
      data-title="${esc(game.title)}"
      data-url="${esc(game.url)}"
      data-image-url="${esc(game.image || '')}"
      data-description="${esc(game.excerpt || '')}"
      data-size="${esc(size)}"
      data-categories="${esc(categories)}">
    <div class="browse-thumb-wrap">
      ${image
        ? `<img class="browse-thumb" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'browse-thumb-placeholder',textContent:'No image'}))">`
        : '<div class="browse-thumb-placeholder">No image</div>'}
      ${size ? `<span class="size-chip">${esc(size)}</span>` : ''}
    </div>
    <div class="browse-card-body">
      <h2 class="browse-card-title" title="${esc(game.title)}">${esc(game.title)}</h2>
      <p class="browse-card-excerpt">${esc(game.excerpt || 'No description available.')}</p>
      <div class="browse-card-actions">
        ${inLibrary
          ? '<span class="in-library-tag">In library</span>'
          : '<button class="btn btn-primary btn-sm" data-action="add" type="button">Add</button>'}
        <a class="btn btn-ghost btn-sm" href="${esc(game.url)}" ${openTarget}>Open</a>
      </div>
    </div>
  </article>`;
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
    description: card.dataset.description || '',
    size: card.dataset.size || '',
    categories: (card.dataset.categories || '').split('|').filter(Boolean),
  });
  if (!res) {
    button.disabled = false;
    button.textContent = 'Add';
    return;
  }
  knownTitles.add(title);
  toast(`Added ${res.added} of ${res.found} link(s) for ${title}`, 'ok');
  button.outerHTML = '<span class="in-library-tag">In library</span>';

  if (boolSetting(browseSettings.auto_start_new_games)) {
    const downloads = await API.req(`/api/lists/${res.id}/downloads`);
    const pending = (downloads || []).filter(d => ['pending', 'failed'].includes(d.status));
    if (pending.length) {
      const ok = await API.req('/api/downloads/batch/start', 'POST', { ids: pending.map(d => d.id) });
      if (ok) toast(`Queued ${ok.queued || pending.length} file(s)`, 'ok');
    }
  }
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
    const btn = e.target.closest('[data-action="add"]');
    if (btn) {
      addCard(btn.closest('.browse-card'), btn);
      return;
    }
    if (e.target.closest('a, button')) return;
    const card = e.target.closest('.browse-card');
    if (!card) return;
    const link = card.querySelector('.browse-card-actions a');
    if (link) link.click();
  });

  loadBrowse('', 1);
});
