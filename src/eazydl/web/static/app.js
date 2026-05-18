const state = {
  query: "",
  selectedDownloads: new Set(),
  currentDownloads: [],
  libraryItems: [],
  libraryByGame: new Map(),
  currentView: "browse",
  expandedDownloadGroups: new Set(),
  settings: {},
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
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3400);
}

function bootStatus(message) {
  const el = $("#boot-status");
  if (el) el.textContent = message;
}

function finishBoot() {
  $("#boot-screen")?.classList.add("is-hidden");
  setTimeout(() => $("#boot-screen")?.remove(), 220);
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}

function setView(name, refresh = true) {
  state.currentView = name;
  const navName = name === "game" ? "browse" : name;
  $$(".nav-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === navName));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === name));
  if (refresh && name === "library") loadLibrary();
  if (refresh && name === "downloads") loadDownloads();
  if (refresh && name === "settings") loadSettings();
}

function initials(title) {
  return String(title || "ED")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function imageMarkup(item, className = "cover") {
  const fallback = `<div class="cover-fallback">${escapeHtml(initials(item.title))}</div>`;
  if (!item.image_url) return fallback;
  return `
    <img class="${className}" src="${escapeHtml(item.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
      onerror="this.hidden=true; this.nextElementSibling.hidden=false">
    <div class="cover-fallback" hidden>${escapeHtml(initials(item.title))}</div>
  `;
}

function termsFor(item) {
  return item.tags || item.categories || [];
}

function tagsMarkup(tags, limit = 8) {
  const values = (tags || []).filter(Boolean).slice(0, limit);
  if (!values.length) return `<span class="tag">untagged</span>`;
  return values.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
}

function sizeLine(item) {
  const parts = [];
  if (item.original_size) parts.push(`Original ${item.original_size}`);
  if (item.repack_size) parts.push(`Repack ${item.repack_size}`);
  return parts.join(" / ");
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!number) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
  return `${(number / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatSpeed(value) {
  return `${formatBytes(value)}/s`;
}

function progressFor(item) {
  return item.total_bytes ? Math.min(100, Math.round((item.bytes_downloaded / item.total_bytes) * 100)) : 0;
}

function fileProgressPercent(completed, total) {
  return total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
}

function etaFor(bytesLeft, speed) {
  if (!speed || speed <= 0 || !bytesLeft) return "ETA unknown";
  const seconds = Math.ceil(bytesLeft / speed);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m left`;
  if (minutes) return `${minutes}m ${seconds % 60}s left`;
  return `${seconds}s left`;
}

function cleanDisplayFilename(item) {
  let name = String(item.filename || item.source_url || "file");
  name = name.split("#").pop() || name;
  name = name.replace(/_+/g, " ");
  name = name.replace(/fitgirl-repacks\.site/ig, " ");
  name = name.replace(/\s+-+\s+/g, " ");
  name = name.replace(/\s*[-–]+\s*fitgirl-repacks\.site\s*[-–]+\s*/ig, " ");
  name = name.replace(/\s+/g, " ").trim();
  return name || "file";
}

function isDuplicateFilename(item) {
  return /\s\(\d+\)(?=\.[^.]+$)/.test(String(item.filename || ""));
}

function statusPriority(status) {
  return {
    downloading: 0,
    queued: 1,
    paused: 2,
    pending: 3,
    failed: 4,
    completed: 5,
  }[status] ?? 6;
}

function queuePosition(item) {
  return Number(item.queue_position || item.id || 0);
}

function queuedDisplayStatus(status) {
  return ["queued", "paused", "failed"].includes(status);
}

function groupDownloads(items) {
  const groups = new Map();
  for (const item of items) {
    const key = String(item.library_item_id || item.game_id || "ungrouped");
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        title: item.game_title || "Ungrouped",
        gameId: item.game_id,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()]
    .map((group) => {
      group.items.sort((a, b) => statusPriority(a.status) - statusPriority(b.status) || queuePosition(a) - queuePosition(b) || a.id - b.id);
      return group;
    })
    .sort((a, b) => {
      const ap = Math.min(...a.items.map((item) => statusPriority(item.status)));
      const bp = Math.min(...b.items.map((item) => statusPriority(item.status)));
      const ai = Math.min(...a.items.map((item) => queuePosition(item)));
      const bi = Math.min(...b.items.map((item) => queuePosition(item)));
      return ap - bp || ai - bi;
    });
}

function groupStats(group, items = group.items) {
  const totalFiles = items.length;
  const completed = items.filter((item) => item.status === "completed").length;
  const active = items.filter((item) => item.status === "downloading");
  const queued = items.filter((item) => item.status === "queued").length;
  const pending = items.filter((item) => item.status === "pending").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const paused = items.filter((item) => item.status === "paused").length;
  const totalBytes = items.reduce((sum, item) => sum + Number(item.total_bytes || 0), 0);
  const doneBytes = items.reduce((sum, item) => sum + Number(item.bytes_downloaded || 0), 0);
  const speed = active.reduce((sum, item) => sum + Number(item.download_speed || 0), 0);
  const percent = fileProgressPercent(completed, totalFiles);
  return { totalFiles, completed, active, queued, pending, failed, paused, totalBytes, doneBytes, speed, percent };
}

function displayItemsForMode(group, mode) {
  if (mode === "active") return group.items.filter((item) => item.status !== "pending");
  if (mode === "queue") return group.items.filter((item) => queuedDisplayStatus(item.status));
  if (mode === "done") return group.items.filter((item) => item.status === "completed" || item.status === "failed");
  return group.items;
}

function linkSortValue(link) {
  const text = `${link.filename || ""} ${link.url || ""}`.toLowerCase();
  const optional = /(optional|bonus|soundtrack|credits|language)/.test(text) ? 1 : 0;
  const match = text.match(/(?:part|pt|\.)(\d{1,4})(?:\.|_|-|$)/);
  const part = match ? Number(match[1]) : 9999;
  return [optional, part, text];
}

function sortedLinks(links) {
  return [...(links || [])].sort((a, b) => {
    const left = linkSortValue(a);
    const right = linkSortValue(b);
    return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2]);
  });
}

function progressForDownloads(downloads) {
  const total = downloads.reduce((sum, item) => sum + Number(item.total_bytes || 0), 0);
  const done = downloads.reduce((sum, item) => sum + Number(item.bytes_downloaded || 0), 0);
  if (!total) {
    const completed = downloads.filter((item) => item.status === "completed").length;
    return downloads.length ? Math.round((completed / downloads.length) * 100) : 0;
  }
  return Math.round((done / total) * 100);
}

function setSelectedCount() {
  $("#metric-selected").textContent = state.selectedDownloads.size.toLocaleString();
  const inline = $("#selected-count-inline");
  if (inline) inline.textContent = state.selectedDownloads.size.toLocaleString();
}

function updateLibraryCache(items) {
  state.libraryItems = items || [];
  state.libraryByGame = new Map(state.libraryItems.map((item) => [String(item.game_id), item]));
}

function gameCard(item, options = {}) {
  const inLibrary = state.libraryByGame.get(String(item.id));
  const card = document.createElement("article");
  card.className = "game-card";
  card.tabIndex = 0;
  card.innerHTML = `
    <div class="cover-wrap">
      ${imageMarkup(item)}
      <span class="size-chip">${escapeHtml(item.repack_size || "size unknown")}</span>
      <button class="quick-download">${options.library ? "Download" : inLibrary ? "Library" : "Add"}</button>
    </div>
    <div class="card-body">
      <div class="title">${escapeHtml(item.title)}</div>
      <div class="muted">${escapeHtml(sizeLine(item) || "No size data")}</div>
    </div>
  `;
  card.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".quick-download")) return;
    if (options.library) openLibraryItem(options.library.id);
    else openStorePage(item.id);
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      if (options.library) openLibraryItem(options.library.id);
      else openStorePage(item.id);
    }
  });
  card.querySelector(".quick-download").addEventListener("click", async () => {
    if (options.library) {
      await startLibraryDownloads(options.library);
    } else if (inLibrary) {
      setView("library");
      openLibraryItem(inLibrary.id);
    } else {
      await addGame(item.id, false);
    }
  });
  return card;
}

function emptyState(text) {
  const el = document.createElement("div");
  el.className = "empty";
  el.textContent = text;
  return el;
}

function updateIndexVisual(status) {
  $("#index-pill").textContent = status.updating
    ? `Index ${status.current_task}`
    : status.exists
      ? `${status.total.toLocaleString()} games`
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

function updateDownloadVisual(data) {
  const items = data.items || [];
  const stats = data.stats || {};
  state.currentDownloads = items;
  const active = items.filter((item) => item.status === "downloading").length;
  const queued = items.filter((item) => queuedDisplayStatus(item.status)).length;
  $("#metric-downloads").textContent = items.length.toLocaleString();
  if ("aria2_running" in stats) {
    $("#aria-pill").textContent = stats.aria2_running ? formatSpeed(stats.download_speed) : "aria2 offline";
  }
  if ("download_speed" in stats) {
    $("#download-speed").textContent = formatSpeed(stats.download_speed);
  }
  $("#download-active").textContent = active.toLocaleString();
  $("#download-queued").textContent = queued.toLocaleString();
  state.selectedDownloads = new Set([...state.selectedDownloads].filter((id) => items.some((item) => item.id === id)));
  setSelectedCount();
}

async function refreshDownloadMetrics() {
  const data = await api("/api/downloads");
  updateDownloadVisual(data);
  return data;
}

async function loadBrowseSections() {
  const host = $("#browse-sections");
  const data = await api("/api/index/sections?limit=18");
  const shelves = data.sections || [];
  host.replaceChildren(...shelves.map((section) => {
    const el = document.createElement("section");
    el.className = "shelf";
    el.innerHTML = `
      <div class="shelf-head">
        <h2>${escapeHtml(section.title)}</h2>
      </div>
      <div class="poster-row"></div>
    `;
    el.querySelector(".poster-row").replaceChildren(...section.items.map((item) => gameCard(item)));
    return el;
  }));
}

async function search() {
  const button = $("#search-button");
  state.query = $("#search-input").value.trim();
  setBusy(button, true);
  try {
    if (!state.query) {
      $("#search-results-panel").classList.add("hidden");
      $("#search-meta").textContent = "Latest entries from your local index.";
      await loadBrowseSections();
      return;
    }
    const data = await api(`/api/index/search?q=${encodeURIComponent(state.query)}&limit=72`);
    $("#search-results-panel").classList.remove("hidden");
    $("#search-meta").textContent = `${data.total.toLocaleString()} result${data.total === 1 ? "" : "s"} for "${state.query}"`;
    $("#results").replaceChildren(...(data.items.length ? data.items.map((item) => gameCard(item)) : [emptyState("No matching games in the local index.")]));
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(button, false);
  }
}

async function addGame(id, jumpToLibrary = true) {
  const data = await api("/api/library", { method: "POST", body: JSON.stringify({ game_id: id }) });
  await loadLibrary(false);
  toast(`Added ${data.downloads.length.toLocaleString()} files`);
  if (jumpToLibrary) {
    setView("library", false);
    openLibraryItem(data.item.id);
  }
  return data;
}

async function openStorePage(id) {
  try {
    const game = await api(`/api/index/games/${encodeURIComponent(id)}`);
    const links = sortedLinks(game.links || []);
    const inLibrary = state.libraryByGame.get(String(game.id));
    $("#game-page").innerHTML = `
      <article class="store-page">
        <div class="store-hero">
          <div class="hero-media">${imageMarkup(game)}</div>
          <div class="hero-body">
            <h1>${escapeHtml(game.title)}</h1>
            <div class="description">${escapeHtml(game.description || "No description in the local index.")}</div>
            <div class="link-offer">
              <div>
                <strong>FuckingFast</strong>
                <div class="muted">${links.length.toLocaleString()} files / ${escapeHtml(game.repack_size || "size unknown")}</div>
              </div>
              <button id="store-add">${inLibrary ? "In Library" : "Add to Library"}</button>
            </div>
          </div>
        </div>
        <aside class="side-info">
          ${game.image_url ? `<img src="${escapeHtml(game.image_url)}" alt="" referrerpolicy="no-referrer">` : ""}
          <div class="info-grid">
            <div><span>Original Size</span><strong>${escapeHtml(game.original_size || "unknown")}</strong></div>
            <div><span>Repack Size</span><strong>${escapeHtml(game.repack_size || "unknown")}</strong></div>
            <div><span>Files</span><strong>${links.length.toLocaleString()}</strong></div>
            <div><span>Updated</span><strong>${escapeHtml(game.updated_at || "unknown")}</strong></div>
          </div>
          <div class="tags">${tagsMarkup(termsFor(game), 16)}</div>
          <a href="${escapeHtml(game.source_url)}" target="_blank" rel="noreferrer"><button class="secondary">Open FitGirl Page</button></a>
        </aside>
      </article>
    `;
    $("#store-add").addEventListener("click", async () => {
      if (inLibrary) {
        setView("library");
        openLibraryItem(inLibrary.id);
      } else {
        await addGame(game.id, true);
      }
    });
    setView("game", false);
  } catch (err) {
    toast(err.message);
  }
}

function librarySidebar(items) {
  return items.map((item) => {
    const button = document.createElement("button");
    button.dataset.libraryId = item.id;
    button.textContent = item.title;
    button.title = item.title;
    button.addEventListener("click", () => openLibraryItem(item.id));
    return button;
  });
}

function libraryCard(item) {
  return gameCard(
    {
      id: item.game_id,
      title: item.title,
      image_url: item.image_url,
      original_size: item.original_size,
      repack_size: item.repack_size,
    },
    { library: item },
  );
}

async function loadLibrary(renderHome = true) {
  const data = await api("/api/library");
  updateLibraryCache(data.items);
  $("#library-list").replaceChildren(...(data.items.length ? librarySidebar(data.items) : [emptyState("No games added yet.")]));
  if (renderHome) {
    $("#library-detail").classList.add("hidden");
    $("#library-home").classList.remove("hidden");
    $("#library-grid").replaceChildren(...(data.items.length ? data.items.map(libraryCard) : [emptyState("Add games from Browse.")]));
  }
  return data;
}

function markActiveLibraryItem(id) {
  $$("#library-list button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.libraryId) === Number(id));
  });
}

async function openLibraryItem(itemId) {
  try {
    setView("library", false);
    const data = await api(`/api/library/${itemId}`);
    const item = data.item;
    const game = item.index_game || item;
    const downloads = item.downloads || [];
    const pendingIds = downloads.filter((row) => ["pending", "queued", "paused", "failed"].includes(row.status)).map((row) => row.id);
    const completedCount = downloads.filter((row) => row.status === "completed").length;
    const percent = progressForDownloads(downloads);
    const categories = game.categories || item.categories || [];
    const tags = game.tags || item.tags || [];
    markActiveLibraryItem(item.id);
    $("#library-home").classList.add("hidden");
    $("#library-detail").classList.remove("hidden");
    $("#library-detail").innerHTML = `
      <article class="library-detail-page">
        <div class="library-detail-hero">
          <div class="hero-media">${imageMarkup(game)}</div>
          <div class="hero-body">
            <h1>${escapeHtml(item.title)}</h1>
            <div class="download-action-bar">
              <button id="library-download">${pendingIds.length ? "Download" : "Downloaded"}</button>
              <div>
                <div class="progress"><span style="width:${percent}%"></span></div>
                <div class="muted">${percent}% / ${completedCount}/${downloads.length} files complete</div>
              </div>
            </div>
          </div>
        </div>
        <div class="library-detail-body">
          <details class="library-files-panel" open>
            <summary>
              <span>Files</span>
              <strong>${downloads.length.toLocaleString()}</strong>
            </summary>
            <div class="link-list">
              ${downloads.map(downloadLinkRow).join("") || `<div class="empty">No files are attached to this game.</div>`}
            </div>
          </details>
          <aside class="side-info">
            <div class="info-grid">
              <div><span>Total Files</span><strong>${downloads.length.toLocaleString()}</strong></div>
              <div><span>Completed</span><strong>${completedCount.toLocaleString()}</strong></div>
              <div><span>Repack Size</span><strong>${escapeHtml(item.repack_size || "unknown")}</strong></div>
              <div><span>Original Size</span><strong>${escapeHtml(item.original_size || "unknown")}</strong></div>
              <div><span>Date Added</span><strong>${escapeHtml(item.created_at || "unknown")}</strong></div>
              <div><span>Categories</span><div class="tags">${tagsMarkup(categories, 8)}</div></div>
              <div><span>Tags</span><div class="tags">${tagsMarkup(tags, 12)}</div></div>
            </div>
            <div class="button-row">
              <a href="${escapeHtml(item.source_url)}" target="_blank" rel="noreferrer"><button class="secondary">Open FitGirl Page</button></a>
              <button id="library-remove" class="danger">Remove</button>
            </div>
          </aside>
        </div>
      </article>
    `;
    bindDownloadCheckboxes($("#library-detail"));
    $("#library-download").addEventListener("click", async () => {
      if (pendingIds.length) await batch("start", pendingIds);
    });
    $("#library-remove").addEventListener("click", () => removeLibraryItem(item.id, item.title));
  } catch (err) {
    toast(err.message);
  }
}

function downloadLinkRow(item) {
  const progress = item.total_bytes ? Math.round((item.bytes_downloaded / item.total_bytes) * 100) : 0;
  return `
    <div class="link-row">
      <input type="checkbox" data-download-id="${item.id}" ${state.selectedDownloads.has(item.id) ? "checked" : ""}>
      <div>
        <div class="row-title">${escapeHtml(item.filename || item.source_url)}</div>
        <div class="row-sub">${escapeHtml(item.error_message || item.source_url)}</div>
        <div class="progress"><span style="width:${progress}%"></span></div>
      </div>
      <span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
    </div>
  `;
}

async function startLibraryDownloads(item) {
  const ids = (item.downloads || [])
    .filter((row) => ["pending", "queued", "paused", "failed"].includes(row.status))
    .map((row) => row.id);
  if (!ids.length) {
    toast("No pending files");
    return;
  }
  await batch("start", ids);
}

async function removeLibraryItem(itemId, title) {
  if (!confirm(`Remove "${title}" from your library? Active downloads for it will be stopped.`)) return;
  try {
    await api(`/api/library/${itemId}`, { method: "DELETE" });
    state.selectedDownloads.clear();
    await loadLibrary(true);
    await refreshDownloadMetrics().catch(() => undefined);
    toast("Removed from library");
  } catch (err) {
    toast(err.message);
  }
}

function bindDownloadCheckboxes(root = document) {
  root.querySelectorAll("[data-download-id]").forEach((box) => {
    box.addEventListener("change", () => {
      const id = Number(box.dataset.downloadId);
      if (box.checked) state.selectedDownloads.add(id);
      else state.selectedDownloads.delete(id);
      setSelectedCount();
    });
  });
}

function bindGroupCheckboxes(root = document) {
  root.querySelectorAll("[data-group-select]").forEach((box) => {
    box.addEventListener("change", () => {
      const ids = String(box.dataset.groupSelect || "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      if (box.checked) ids.forEach((id) => state.selectedDownloads.add(id));
      else ids.forEach((id) => state.selectedDownloads.delete(id));
      renderDownloads(state.currentDownloads);
    });
  });
}

function fileRow(item, compact = false) {
  const progress = progressFor(item);
  const name = cleanDisplayFilename(item);
  const div = document.createElement("div");
  div.className = compact ? `download-file compact-file ${item.status}` : `download-file ${item.status}`;
  const bits = [];
  if (item.total_bytes) bits.push(`${formatBytes(item.bytes_downloaded)} / ${formatBytes(item.total_bytes)}`);
  else if (item.bytes_downloaded) bits.push(formatBytes(item.bytes_downloaded));
  if (item.download_speed) bits.push(formatSpeed(item.download_speed));
  if (item.error_message) bits.push(item.error_message);
  const meta = bits.length ? `<div class="row-sub">${escapeHtml(bits.join(" / "))}</div>` : "";
  const showProgress = item.status === "downloading" || Boolean(item.total_bytes) || Boolean(item.bytes_downloaded);
  div.innerHTML = `
    <input type="checkbox" data-download-id="${item.id}" aria-label="Select file" ${state.selectedDownloads.has(item.id) ? "checked" : ""}>
    <div>
      <div class="row-title">${escapeHtml(name)}${isDuplicateFilename(item) ? ` <span class="inline-warning">duplicate name</span>` : ""}</div>
      ${meta}
      ${showProgress ? `<div class="progress"><span style="width:${progress}%"></span></div>` : ""}
    </div>
    <span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
  `;
  bindDownloadCheckboxes(div);
  return div;
}

function currentDownloadPanel(groups) {
  const host = $("#current-download-panel");
  const activeGroup = groups.find((group) => group.items.some((item) => item.status === "downloading"));
  if (!activeGroup) {
    host.innerHTML = `
      <div class="empty current-empty">
        <strong>No active download</strong>
        <span>Queue a game and EasyDL will feed aria2 only up to your simultaneous file limit.</span>
      </div>
    `;
    return;
  }

  const stats = groupStats(activeGroup, displayItemsForMode(activeGroup, "active"));
  const activeFile = stats.active[0];
  const activeBytesLeft = activeFile?.total_bytes
    ? Math.max(0, Number(activeFile.total_bytes || 0) - Number(activeFile.bytes_downloaded || 0))
    : 0;
  const eta = activeBytesLeft ? etaFor(activeBytesLeft, Number(activeFile.download_speed || stats.speed || 0)) : "ETA unknown";
  host.innerHTML = `
    <div class="current-card">
      <div>
        <span class="label">Downloading Now</span>
        <h1>${escapeHtml(activeGroup.title)}</h1>
      </div>
      <div class="current-file">
        <strong>${escapeHtml(cleanDisplayFilename(activeFile))}</strong>
        <span>${stats.completed}/${stats.totalFiles} files downloaded / ${formatSpeed(stats.speed)} / ETA to next file: ${eta}</span>
      </div>
      <div>
        <div class="progress large"><span style="width:${stats.percent}%"></span></div>
        <div class="current-progress">${stats.percent}% files / ${formatBytes(stats.doneBytes)} downloaded</div>
      </div>
    </div>
  `;
}

function groupCard(group, mode) {
  const displayItems = displayItemsForMode(group, mode);
  const stats = groupStats(group, displayItems);
  const expanded = state.expandedDownloadGroups.has(group.id);
  const actionableIds = displayItems.filter((item) => mode === "done" ? true : item.status !== "completed").map((item) => item.id);
  const selectedCount = actionableIds.filter((id) => state.selectedDownloads.has(id)).length;
  const checked = actionableIds.length > 0 && selectedCount === actionableIds.length;
  const partial = selectedCount > 0 && !checked;
  const visibleFiles = expanded ? displayItems : displayItems.slice(0, mode === "active" ? 4 : 3);
  const groupProgress = mode === "active"
    ? ""
    : `
    <div class="group-progress-row">
      <div class="progress"><span style="width:${stats.percent}%"></span></div>
      <span>${stats.percent}%</span>
    </div>`;
  const div = document.createElement("article");
  div.className = `download-group-card ${mode}`;
  div.innerHTML = `
    <header class="download-group-head">
      <label class="group-select">
        <input type="checkbox" data-group-select="${actionableIds.join(",")}" ${checked ? "checked" : ""}>
        <span></span>
      </label>
      <div class="download-group-title">
        <strong>${escapeHtml(group.title)}</strong>
        <span>${stats.completed}/${stats.totalFiles} downloaded${stats.queued ? ` / ${stats.queued} queued` : ""}${stats.failed ? ` / ${stats.failed} failed` : ""}${stats.paused ? ` / ${stats.paused} paused` : ""}</span>
      </div>
      <div class="download-group-actions">
        ${mode === "queue" ? `<button class="small" data-action="start">Start / Resume</button>` : ""}
        ${mode === "queue" ? `<button class="small secondary" data-action="top">Move Top</button>` : ""}
        ${mode === "active" ? `<button class="small secondary" data-action="pause">Pause Game</button>` : ""}
        ${mode !== "done" ? `<button class="small danger" data-action="stop">Reset</button>` : ""}
        <button class="small secondary" data-action="toggle">${expanded ? "Hide Files" : `Show All Files${displayItems.length > visibleFiles.length ? ` (${displayItems.length})` : ""}`}</button>
      </div>
    </header>
    ${groupProgress}
    <div class="download-files"></div>
  `;
  const checkbox = div.querySelector("[data-group-select]");
  if (checkbox) checkbox.indeterminate = partial;
  div.querySelector(".download-files").replaceChildren(...visibleFiles.map((item) => fileRow(item, !expanded)));
  bindDownloadCheckboxes(div);
  bindGroupCheckboxes(div);
  div.querySelector('[data-action="toggle"]').addEventListener("click", () => {
    if (expanded) state.expandedDownloadGroups.delete(group.id);
    else state.expandedDownloadGroups.add(group.id);
    renderDownloads(state.currentDownloads);
  });
  div.querySelector('[data-action="start"]')?.addEventListener("click", () => batch("start", displayItems.filter((item) => queuedDisplayStatus(item.status)).map((item) => item.id)));
  div.querySelector('[data-action="top"]')?.addEventListener("click", () => batch("top", displayItems.filter((item) => queuedDisplayStatus(item.status)).map((item) => item.id)));
  div.querySelector('[data-action="pause"]')?.addEventListener("click", () => batch("pause", displayItems.filter((item) => item.status === "downloading" || item.status === "queued").map((item) => item.id)));
  div.querySelector('[data-action="stop"]')?.addEventListener("click", () => batch("stop", displayItems.filter((item) => item.status !== "completed").map((item) => item.id)));
  return div;
}

function renderDownloads(items) {
  const groups = groupDownloads(items);
  currentDownloadPanel(groups);
  const active = groups.filter((group) => group.items.some((item) => item.status === "downloading"));
  const activeIds = new Set(active.map((group) => group.id));
  const queue = groups.filter((group) => !activeIds.has(group.id) && group.items.some((item) => queuedDisplayStatus(item.status)));
  const queueIds = new Set(queue.map((group) => group.id));
  const done = groups.filter((group) => !activeIds.has(group.id) && !queueIds.has(group.id) && displayItemsForMode(group, "done").length);
  const visibleIds = new Set([
    ...active.flatMap((group) => displayItemsForMode(group, "active").map((item) => item.id)),
    ...queue.flatMap((group) => displayItemsForMode(group, "queue").map((item) => item.id)),
    ...done.flatMap((group) => displayItemsForMode(group, "done").map((item) => item.id)),
  ]);
  state.selectedDownloads = new Set([...state.selectedDownloads].filter((id) => visibleIds.has(id)));
  const limit = state.settings.max_concurrent || "1";
  $("#download-note").textContent = `EasyDL queue is the source of truth. aria2 receives at most ${limit} active file${String(limit) === "1" ? "" : "s"} at a time.`;
  $("#downloading-now").replaceChildren(...(active.length ? active.map((group) => groupCard(group, "active")) : [emptyState("Nothing is downloading right now.")]));
  $("#download-queue").replaceChildren(...(queue.length ? queue.map((group) => groupCard(group, "queue")) : [emptyState("There are no downloads in the queue.")]));
  $("#download-completed").replaceChildren(...(done.length ? done.map((group) => groupCard(group, "done")) : [emptyState("No completed or failed files yet.")]));
  setSelectedCount();
}

async function loadDownloads() {
  try {
    const data = await refreshDownloadMetrics();
    renderDownloads(data.items);
  } catch (err) {
    toast(err.message);
  }
}

async function batch(action, ids = [...state.selectedDownloads]) {
  if (!ids.length) {
    toast("No downloads selected");
    return;
  }
  try {
    const result = await api(`/api/downloads/batch/${action}`, { method: "POST", body: JSON.stringify({ ids }) });
    if (action === "start") toast(`Queued ${result.queued ?? result.started ?? 0}, started ${result.started ?? 0}`);
    if (action === "top") toast(`Moved ${result.moved ?? 0} files to the top`);
    await loadDownloads();
    if (state.currentView === "library") await loadLibrary(false);
  } catch (err) {
    toast(err.message);
  }
}

async function loadSettings() {
  try {
    const settings = await api("/api/settings");
    state.settings = settings;
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
    state.settings = await api("/api/settings");
    toast("Settings saved");
  } catch (err) {
    toast(err.message);
  }
}

async function indexTask(kind) {
  const buttons = kind === "update" ? [$("#update-index"), $("#setup-update")] : [$("#setup-rebuild"), $("#rebuild-index-settings")];
  buttons.forEach((button) => setBusy(button, true));
  try {
    await api(`/api/index/${kind}`, { method: "POST", body: "{}" });
    toast(`${kind} started`);
    await refreshIndexStatus();
  } catch (err) {
    toast(err.message);
  } finally {
    buttons.forEach((button) => setBusy(button, false));
  }
}

function connectProgress() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/progress`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.index) updateIndexVisual(data.index);
    if (data.downloads) {
      updateDownloadVisual({ items: data.downloads, stats: {} });
      if ($("#downloads").classList.contains("active")) renderDownloads(data.downloads);
    }
  };
  ws.onclose = () => setTimeout(connectProgress, 2500);
}

function filterLibrary() {
  const needle = $("#library-filter").value.trim().toLowerCase();
  const filtered = state.libraryItems.filter((item) => item.title.toLowerCase().includes(needle));
  $("#library-list").replaceChildren(...(filtered.length ? librarySidebar(filtered) : [emptyState("No matching library games.")]));
  $("#library-grid").replaceChildren(...(filtered.length ? filtered.map(libraryCard) : [emptyState("No matching library games.")]));
}

function bindEvents() {
  $$(".nav-tab").forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
  $("#search-button").addEventListener("click", search);
  $("#search-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
  });
  $("#back-to-browse").addEventListener("click", () => setView("browse"));
  $("#refresh-library").addEventListener("click", () => loadLibrary(true));
  $("#library-filter").addEventListener("input", filterLibrary);
  $("#select-active").addEventListener("click", () => {
    state.currentDownloads
      .filter((item) => item.status === "downloading")
      .forEach((item) => state.selectedDownloads.add(item.id));
    renderDownloads(state.currentDownloads);
  });
  $("#select-queued").addEventListener("click", () => {
    state.currentDownloads
      .filter((item) => queuedDisplayStatus(item.status))
      .forEach((item) => state.selectedDownloads.add(item.id));
    renderDownloads(state.currentDownloads);
  });
  $("#clear-selected").addEventListener("click", () => {
    state.selectedDownloads.clear();
    renderDownloads(state.currentDownloads);
  });
  $("#start-selected").addEventListener("click", () => batch("start"));
  $("#pause-selected").addEventListener("click", () => batch("pause"));
  $("#resume-selected").addEventListener("click", () => batch("resume"));
  $("#stop-selected").addEventListener("click", () => batch("stop"));
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#update-index").addEventListener("click", () => indexTask("update"));
  $("#setup-update").addEventListener("click", () => indexTask("update"));
  $("#setup-rebuild").addEventListener("click", () => indexTask("rebuild"));
  $("#rebuild-index-settings").addEventListener("click", () => indexTask("rebuild"));
}

async function boot() {
  bindEvents();
  bootStatus("Loading index");
  await refreshIndexStatus().catch((err) => toast(err.message));
  bootStatus("Loading library");
  await loadLibrary(false).catch((err) => toast(err.message));
  bootStatus("Loading settings");
  state.settings = await api("/api/settings").catch(() => ({}));
  bootStatus("Loading downloads");
  await refreshDownloadMetrics().catch(() => undefined);
  bootStatus("Loading browse");
  await loadBrowseSections().catch((err) => toast(err.message));
  setSelectedCount();
  connectProgress();
  finishBoot();
}

boot();
