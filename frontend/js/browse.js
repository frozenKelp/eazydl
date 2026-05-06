let knownTitles = new Set();
let currentQuery = '';

async function refreshKnownTitles() {
  const lists = await API.req('/api/lists');
  if (lists) knownTitles = new Set(lists.map(l => l.name));
}

async function loadBrowse(query = '') {
  currentQuery = query;
  const root = document.getElementById('browse-results');
  root.innerHTML = `<div class="loading"><span class="spinner"></span> ${query ? 'Searching' : 'Loading latest games'}…</div>`;
  await refreshKnownTitles();
  const params = new URLSearchParams({ query });
  const data = await API.req(`/api/scrape/search?${params.toString()}`);
  if (!data) return;
  const games = data.games || [];
  if (!games.length) {
    root.innerHTML = `<div class="empty-state"><div class="empty-icon">⌕</div><h3>No games found</h3><p>Try a different search term.</p></div>`;
    return;
  }
  root.innerHTML = `<div class="browse-grid">${games.map(renderBrowseCard).join('')}</div>`;
}

function proxiedImage(url) {
  if (!url) return '';
  return `/api/image?url=${encodeURIComponent(url)}`;
}

function renderBrowseCard(game) {
  const inLibrary = knownTitles.has(game.title);
  const image = proxiedImage(game.image);
  return `<article class="browse-card" data-title="${esc(game.title)}" data-url="${esc(game.url)}">
    <div class="browse-thumb-wrap">
      ${image ? `<img class="browse-thumb" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'browse-thumb-placeholder',textContent:'▧'}))">` : '<div class="browse-thumb-placeholder">▧</div>'}
    </div>
    <div class="browse-card-body">
      <h2 class="browse-card-title" title="${esc(game.title)}">${esc(game.title)}</h2>
      <p class="browse-card-excerpt">${esc(game.excerpt || 'No description available.')}</p>
      <div class="browse-card-actions">
        ${inLibrary ? '<span class="in-library-tag">✓ In library</span>' : `<button class="btn btn-primary btn-sm" data-action="add" type="button">Add to Library</button>`}
        <a class="btn btn-ghost btn-sm" href="${esc(game.url)}" target="_blank" rel="noopener">Open</a>
      </div>
    </div>
  </article>`;
}

async function addCard(card, button) {
  const title = card.dataset.title;
  const gameUrl = card.dataset.url;
  button.disabled = true;
  button.textContent = 'Scraping…';
  const res = await API.req('/api/games', 'POST', { title, game_url: gameUrl });
  if (!res) {
    button.disabled = false;
    button.textContent = 'Add to Library';
    return;
  }
  knownTitles.add(title);
  toast(`Added ${res.added} link(s) for ${title}`, 'ok');
  button.outerHTML = '<span class="in-library-tag">✓ In library</span>';
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const home = document.getElementById('home-btn');
  const root = document.getElementById('browse-results');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadBrowse(input.value.trim());
  });
  home.addEventListener('click', () => {
    input.value = '';
    loadBrowse('');
  });
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="add"]');
    if (!btn) return;
    const card = btn.closest('.browse-card');
    addCard(card, btn);
  });

  loadBrowse(currentQuery);
});
