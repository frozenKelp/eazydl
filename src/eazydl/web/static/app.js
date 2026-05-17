const state = {
  query: "",
  selectedDownloads: new Set(),
  currentDownloads: [],
  indexStatus: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3600);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
}

function setView(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === name));
  if (name === "library") loadLibrary();
  if (name === "downloads") loadDownloads();
  if (name === "settings") loadSettings();
}

function sizeLine(item) {
  const parts = [];
  if (item.original_size) parts.push(`Original ${item.original_size}`);
  if (item.repack_size) parts.push(`Repack ${item.repack_size}`);
  return parts.join(" / ");
}

function initials(title) {
  return String(title || "ED").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function imageMarkup(item, className = "cover") {
  if (!item.image_url) {
    return `<div class="cover-fallback">${escapeHtml(initials(item.title))}</div>`;
  }
  return `<img class="${className}" src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className:'cover-fallback', textContent:'${escapeHtml(initials(item.title))}'}))">`;
}

function tagsMarkup(tags, limit = 5) {
  const values = (tags || []).filter(Boolean).slice(0, limit);
  if (!values.length) return `<span class="tag">untagged</span>`;
  return values.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
}

function gameCard(item) {
  const div = document.createElement("article");
  div.className = "game-card";
  div.innerHTML = `
    <div class="cover-wrap">
      ${imageMarkup(item)}
      <div class="size-badge">${escapeHtml(item.repack_size || "size unknown")}</div>
    </div>
    <div class="card-body">
      <div class="title">${escapeHtml(item.title)}</div>
      <div class="muted">${escapeHtml(sizeLine(item) || "No size data")}</div>
      <div class="tags">${tagsMarkup(item.tags, 4)}</div>
      <div class="card-actions">
        <button data-action="details">Details</button>
        <button class="secondary" data-action="add">Add</button>
      </div>
    </div>
  `;
  div.querySelector('[data-action="details"]').addEventListener("click", () => showGame(item.id));
  div.querySelector('[data-action="add"]').addEventListener("click", () => addGame(item.id));
  return div;
}

function emptyState(text) {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  return el;
}

function updateIndexVisual(status) {
  state.indexStatus = status;
  $("#index-pill").textContent = status.updating
    ? `Index ${status.current_task}`
    : status.exists
      ? `${status.total.toLocaleString()} indexed`
      : "No index";
  $("#setup").classList.toggle("hidden", status.exists);
  $("#metric-total").textContent = status.exists ? status.total.toLocaleString() : "0";
  $("#metric-taxonomies").textContent = status.exists ? `${status.categories}/${status.tags}` : "0/0";
}

async function refreshIndexStatus() {
  const status = await api("/api/index/status");
  updateIndexVisual(status);
  return status;
}

async function refreshDownloadMetrics() {
  const data = await api("/api/downloads");
  const active = data.items.filter((item) => ["downloading", "queued"].includes(item.status)).length;
  $("#metric-downloads").textContent = data.items.length.toLocaleString();
  $("#metric-aria").textContent = data.stats.aria2_running ? `${active} active` : "offline";
  state.currentDownloads = data.items;
  return data;
}

async function search() {
  const button = $("#search-button");
  state.query = $("#search-input").value.trim();
  setBusy(button, true);
  try {
    const data = await api(`/api/index/search?q=${encodeURIComponent(state.query)}&limit=60`);
    $("#search-meta").textContent = data.total
      ? `${data.total.toLocaleString()} result${data.total === 1 ? "" : "s"}${state.query ? ` for "${state.query}"` : ""}`
      : "No results";
    const results = $("#results");
    results.replaceChildren(...(data.items.length ? data.items.map(gameCard) : [emptyState("No matching games in the local index.")]));
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(button, false);
  }
}

async function showGame(id) {
  try {
    const game = await api(`/api/index/games/${encodeURIComponent(id)}`);
    const links = game.links || [];
    const detail = $("#game-detail");
    detail.innerHTML = `
      <article class="detail">
        <div class="detail-media">${imageMarkup(game, "cover")}</div>
        <div class="detail-body">
          <div class="detail-head">
            <div>
              <h2>${escapeHtml(game.title)}</h2>
              <p class="muted">${escapeHtml(game.source_url)}</p>
            </div>
            <form method="dialog"><button class="ghost">Close</button></form>
          </div>
          <div class="detail-grid">
            <div class="detail-metric"><span>Original</span><strong>${escapeHtml(game.original_size || "unknown")}</strong></div>
            <div class="detail-metric"><span>Repack</span><strong>${escapeHtml(game.repack_size || "unknown")}</strong></div>
            <div class="detail-metric"><span>Links</span><strong>${links.length.toLocaleString()}</strong></div>
            <div class="detail-metric"><span>Updated</span><strong>${escapeHtml(game.updated_at || "unknown")}</strong></div>
          </div>
          <div class="tags">${tagsMarkup(game.tags, 12)}</div>
          <p class="description">${escapeHtml(game.description || "No description in the local record.")}</p>
          <div class="button-row">
            <button id="detail-add">Add To Library</button>
            <a href="${escapeHtml(game.source_url)}" target="_blank" rel="noreferrer"><button class="secondary">Open Source</button></a>
          </div>
          <div class="link-preview">
            <strong>Link preview</strong>
            ${links.slice(0, 10).map((link) => `<div>${escapeHtml(link.filename || link.url)}</div>`).join("") || `<div>No links in this record.</div>`}
          </div>
        </div>
      </article>
    `;
    $("#detail-add").addEventListener("click", () => addGame(game.id));
    $("#game-dialog").showModal();
  } catch (err) {
    toast(err.message);
  }
}

async function addGame(id) {
  try {
    const data = await api("/api/library", { method: "POST", body: JSON.stringify({ game_id: id }) });
    toast(`Added ${data.downloads.length.toLocaleString()} links`);
    await refreshDownloadMetrics();
  } catch (err) {
    toast(err.message);
  }
}

function libraryRow(item) {
  const div = document.createElement("article");
  div.className = "list-row";
  const percent = item.download_count ? Math.round((item.completed_count / item.download_count) * 100) : 0;
  div.innerHTML = `
    <div>
      <div class="row-title">${escapeHtml(item.title)}</div>
      <div class="row-sub">${escapeHtml(sizeLine(item) || "No size data")} / ${item.completed_count}/${item.download_count} complete</div>
      <div class="progress"><span style="width:${percent}%"></span></div>
    </div>
    <div class="button-row">
      <button class="secondary" data-action="downloads">Downloads</button>
      <button class="danger" data-action="remove">Remove</button>
    </div>
  `;
  div.querySelector('[data-action="downloads"]').addEventListener("click", () => setView("downloads"));
  div.querySelector('[data-action="remove"]').addEventListener("click", async () => {
    await api(`/api/library/${item.id}`, { method: "DELETE" });
    toast("Removed from library");
    await loadLibrary();
    await refreshDownloadMetrics();
  });
  return div;
}

async function loadLibrary() {
  try {
    const data = await api("/api/library");
    $("#library-list").replaceChildren(...(data.items.length ? data.items.map(libraryRow) : [emptyState("Your library is empty. Add a game from Browse.")]));
  } catch (err) {
    toast(err.message);
  }
}

function statusClass(status) {
  return `status ${String(status || "pending").toLowerCase()}`;
}

function progressFor(item) {
  return item.total_bytes ? Math.round((item.bytes_downloaded / item.total_bytes) * 100) : 0;
}

function downloadRow(item) {
  const progress = progressFor(item);
  const div = document.createElement("div");
  div.className = "download-row";
  div.innerHTML = `
    <input type="checkbox" aria-label="Select download" ${state.selectedDownloads.has(item.id) ? "checked" : ""}>
    <div>
      <div class="row-title">${escapeHtml(item.filename || item.source_url)}</div>
      <div class="row-sub">${escapeHtml(item.error_message || item.source_url)}</div>
      <div class="progress"><span style="width:${progress}%"></span></div>
    </div>
    <div><span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span><div class="row-sub">${progress}%</div></div>
  `;
  div.querySelector("input").addEventListener("change", (event) => {
    if (event.target.checked) state.selectedDownloads.add(item.id);
    else state.selectedDownloads.delete(item.id);
  });
  return div;
}

function groupDownloads(items) {
  const groups = new Map();
  for (const item of items) {
    const name = item.game_title || "Ungrouped";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups.entries()];
}

function downloadGroup([name, items]) {
  const active = items.filter((item) => ["downloading", "queued"].includes(item.status)).length;
  const done = items.filter((item) => item.status === "completed").length;
  const div = document.createElement("article");
  div.className = "download-group";
  div.innerHTML = `
    <div class="download-group-head">
      <div>
        <div class="row-title">${escapeHtml(name)}</div>
        <div class="row-sub">${done}/${items.length} complete / ${active} active</div>
      </div>
      <button class="secondary" data-action="select">Select Group</button>
    </div>
  `;
  div.querySelector('[data-action="select"]').addEventListener("click", () => {
    items.forEach((item) => state.selectedDownloads.add(item.id));
    renderDownloads(state.currentDownloads);
  });
  div.append(...items.map(downloadRow));
  return div;
}

function renderDownloads(items) {
  const groups = groupDownloads(items);
  $("#downloads-list").replaceChildren(...(groups.length ? groups.map(downloadGroup) : [emptyState("No downloads yet. Add a game from Browse.")]));
}

async function loadDownloads() {
  try {
    const data = await refreshDownloadMetrics();
    $("#download-stats").textContent = data.stats.aria2_running
      ? `aria2 active ${data.stats.num_active}, waiting ${data.stats.num_waiting}, stopped ${data.stats.num_stopped}`
      : "aria2 is offline. Starting a download will try to launch it.";
    renderDownloads(data.items);
  } catch (err) {
    toast(err.message);
  }
}

async function batch(action) {
  const ids = [...state.selectedDownloads];
  if (!ids.length) {
    toast("No downloads selected");
    return;
  }
  try {
    await api(`/api/downloads/batch/${action}`, { method: "POST", body: JSON.stringify({ ids }) });
    await loadDownloads();
  } catch (err) {
    toast(err.message);
  }
}

async function loadSettings() {
  try {
    const settings = await api("/api/settings");
    const form = $("#settings-form");
    for (const [key, value] of Object.entries(settings)) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === "checkbox") field.checked = value === "true";
      else field.value = value;
    }
  } catch (err) {
    toast(err.message);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {};
  for (const field of [...form.elements]) {
    if (!field.name) continue;
    body[field.name] = field.type === "checkbox" ? field.checked : field.value;
  }
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    toast("Settings saved");
  } catch (err) {
    toast(err.message);
  }
}

async function indexTask(kind) {
  const button = kind === "update" ? $("#update-index") : $("#setup-rebuild");
  setBusy(button, true);
  try {
    await api(`/api/index/${kind}`, { method: "POST", body: "{}" });
    toast(`${kind} started`);
    await refreshIndexStatus();
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(button, false);
  }
}

function connectProgress() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/progress`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.index) updateIndexVisual(data.index);
    if (data.downloads) {
      state.currentDownloads = data.downloads;
      $("#metric-downloads").textContent = data.downloads.length.toLocaleString();
      const active = data.downloads.filter((item) => ["downloading", "queued"].includes(item.status)).length;
      $("#metric-aria").textContent = active ? `${active} active` : $("#metric-aria").textContent;
      if ($("#downloads").classList.contains("active")) renderDownloads(data.downloads);
    }
  };
  ws.onclose = () => setTimeout(connectProgress, 2500);
}

function bindEvents() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
  $("#search-button").addEventListener("click", search);
  $("#search-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
  });
  $("#update-index").addEventListener("click", () => indexTask("update"));
  $("#setup-update").addEventListener("click", () => indexTask("update"));
  $("#setup-rebuild").addEventListener("click", () => indexTask("rebuild"));
  $("#refresh-library").addEventListener("click", loadLibrary);
  $("#select-visible").addEventListener("click", () => {
    state.currentDownloads.forEach((item) => state.selectedDownloads.add(item.id));
    renderDownloads(state.currentDownloads);
  });
  $("#start-selected").addEventListener("click", () => batch("start"));
  $("#pause-selected").addEventListener("click", () => batch("pause"));
  $("#resume-selected").addEventListener("click", () => batch("resume"));
  $("#stop-selected").addEventListener("click", () => batch("stop"));
  $("#settings-form").addEventListener("submit", saveSettings);
}

async function boot() {
  bindEvents();
  await refreshIndexStatus().catch((err) => toast(err.message));
  await refreshDownloadMetrics().catch(() => undefined);
  await search();
  connectProgress();
}

boot();
