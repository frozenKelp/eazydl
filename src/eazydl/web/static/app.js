const state = {
  query: "",
  selectedDownloads: new Set(),
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

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3500);
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

function card(item) {
  const div = document.createElement("article");
  div.className = "card";
  div.innerHTML = `
    ${item.image_url ? `<img class="cover" src="${item.image_url}" alt="">` : `<div class="cover"></div>`}
    <div class="card-body">
      <div class="title"></div>
      <div class="meta">${sizeLine(item)}</div>
      <div class="tags">${(item.tags || []).slice(0, 4).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="actions">
        <button data-action="details">Details</button>
        <button class="secondary" data-action="add">Add</button>
      </div>
    </div>
  `;
  div.querySelector(".title").textContent = item.title;
  div.querySelector('[data-action="details"]').addEventListener("click", () => showGame(item.id));
  div.querySelector('[data-action="add"]').addEventListener("click", () => addGame(item.id));
  return div;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function refreshIndexStatus() {
  const status = await api("/api/index/status");
  $("#index-pill").textContent = status.updating
    ? `Index ${status.current_task}`
    : status.exists
      ? `${status.total} indexed`
      : "No index";
  $("#setup").classList.toggle("hidden", status.exists);
  return status;
}

async function search() {
  state.query = $("#search-input").value.trim();
  const data = await api(`/api/index/search?q=${encodeURIComponent(state.query)}&limit=48`);
  $("#search-meta").textContent = data.total ? `${data.total} match${data.total === 1 ? "" : "es"}` : "No matches";
  const results = $("#results");
  results.replaceChildren(...data.items.map(card));
}

async function showGame(id) {
  const game = await api(`/api/index/games/${encodeURIComponent(id)}`);
  const detail = $("#game-detail");
  detail.innerHTML = `
    <h2>${escapeHtml(game.title)}</h2>
    <p class="meta">${escapeHtml(sizeLine(game))}</p>
    <div class="tags">${(game.tags || []).slice(0, 12).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
    <p>${escapeHtml(game.description || "")}</p>
    <p class="meta">${(game.links || []).length} link${(game.links || []).length === 1 ? "" : "s"}</p>
    <div class="actions"><button id="detail-add">Add</button><a href="${game.source_url}" target="_blank" rel="noreferrer"><button class="secondary">Open Source</button></a></div>
  `;
  $("#detail-add").addEventListener("click", () => addGame(game.id));
  $("#game-dialog").showModal();
}

async function addGame(id) {
  const data = await api("/api/library", { method: "POST", body: JSON.stringify({ game_id: id }) });
  toast(`Added ${data.downloads.length} links`);
}

async function loadLibrary() {
  const data = await api("/api/library");
  const rows = data.items.map((item) => {
    const div = document.createElement("article");
    div.className = "row";
    div.innerHTML = `
      <div>
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="meta">${escapeHtml(sizeLine(item))} / ${item.completed_count}/${item.download_count} complete</div>
      </div>
      <button class="secondary">Downloads</button>
    `;
    div.querySelector("button").addEventListener("click", () => setView("downloads"));
    return div;
  });
  $("#library-list").replaceChildren(...rows);
}

function downloadRow(item) {
  const progress = item.total_bytes ? Math.round((item.bytes_downloaded / item.total_bytes) * 100) : 0;
  const div = document.createElement("article");
  div.className = "row download-row";
  div.innerHTML = `
    <input type="checkbox" ${state.selectedDownloads.has(item.id) ? "checked" : ""}>
    <div>
      <div class="title">${escapeHtml(item.filename || item.source_url)}</div>
      <div class="meta">${escapeHtml(item.game_title || "")} / ${escapeHtml(item.status)}</div>
      <div class="progress"><span style="width:${progress}%"></span></div>
    </div>
    <div class="meta">${progress}%</div>
  `;
  div.querySelector("input").addEventListener("change", (event) => {
    if (event.target.checked) state.selectedDownloads.add(item.id);
    else state.selectedDownloads.delete(item.id);
  });
  return div;
}

async function loadDownloads() {
  const data = await api("/api/downloads");
  $("#download-stats").textContent = data.stats.aria2_running
    ? `aria2 active ${data.stats.num_active}, waiting ${data.stats.num_waiting}`
    : "aria2 offline";
  $("#downloads-list").replaceChildren(...data.items.map(downloadRow));
}

async function batch(action) {
  const ids = [...state.selectedDownloads];
  if (!ids.length) return toast("No downloads selected");
  await api(`/api/downloads/batch/${action}`, { method: "POST", body: JSON.stringify({ ids }) });
  await loadDownloads();
}

async function loadSettings() {
  const settings = await api("/api/settings");
  const form = $("#settings-form");
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = value === "true";
    else field.value = value;
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
  await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
  toast("Settings saved");
}

async function indexTask(kind) {
  await api(`/api/index/${kind}`, { method: "POST", body: "{}" });
  toast(`${kind} started`);
  await refreshIndexStatus();
}

function connectProgress() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/progress`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.index) {
      $("#index-pill").textContent = data.index.updating
        ? `Index ${data.index.current_task}`
        : data.index.exists
          ? `${data.index.total} indexed`
          : "No index";
      $("#setup").classList.toggle("hidden", data.index.exists);
    }
    if ($("#downloads").classList.contains("active")) {
      $("#downloads-list").replaceChildren(...(data.downloads || []).map(downloadRow));
    }
  };
  ws.onclose = () => setTimeout(connectProgress, 2500);
}

function boot() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
  $("#search-button").addEventListener("click", search);
  $("#search-input").addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
  $("#update-index").addEventListener("click", () => indexTask("update"));
  $("#setup-update").addEventListener("click", () => indexTask("update"));
  $("#setup-rebuild").addEventListener("click", () => indexTask("rebuild"));
  $("#refresh-library").addEventListener("click", loadLibrary);
  $("#start-selected").addEventListener("click", () => batch("start"));
  $("#pause-selected").addEventListener("click", () => batch("pause"));
  $("#resume-selected").addEventListener("click", () => batch("resume"));
  $("#stop-selected").addEventListener("click", () => batch("stop"));
  $("#settings-form").addEventListener("submit", saveSettings);
  refreshIndexStatus().then(search).catch((err) => toast(err.message));
  connectProgress();
}

boot();
