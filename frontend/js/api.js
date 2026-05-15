const SETTINGS_DEFAULTS = {
  download_path: 'downloads',
  max_concurrent: '3',
  connections_per_file: '4',
  browse_items_per_page: '24',
  browse_card_height: '172',
  library_card_height: '172',
  card_ratio_width: '4',
  card_ratio_height: '3',
  browse_open_links_new_tab: 'true',
  library_default_detail: 'false',
  library_show_file_urls: 'true',
  confirm_delete: 'true',
  auto_start_new_games: 'false',
  interface_scale: '100',
  theme_density: 'comfortable',
  reduce_motion: 'false',
};

let cachedSettingsPromise = null;
let navEls = { dot: null, label: null, speed: null };
window.aria2Online = true;

const API = {
  _ws: null,
  _callbacks: [],
  _wsSeenAt: 0,
  _reconnectTimer: null,

  async req(url, method = 'GET', body = null, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
      if (body !== null) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        toast(err.detail || `Request failed (${res.status})`, 'err');
        return null;
      }
      return await res.json();
    } catch (err) {
      toast(err?.name === 'AbortError' ? 'Request timed out. Try again in a moment.' : 'Network error. Is the server running?', 'err');
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  connectWS() {
    if (this._ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(this._ws.readyState)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this._ws = new WebSocket(`${proto}://${location.host}/ws/progress`);

    this._ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'progress') return;
        this._wsSeenAt = Date.now();
        updateNavStatus(msg.aria2_ok, msg.data || []);
        this._callbacks.forEach(cb => cb(msg));
      } catch {
        // Ignore malformed websocket frames.
      }
    };

    this._ws.onclose = () => {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this.connectWS(), 3000);
    };
    this._ws.onerror = () => this._ws.close();
  },

  onProgress(cb) {
    this._callbacks.push(cb);
  },
};

function readableMessage(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(readableMessage).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    if (value.msg) return readableMessage(value.msg);
    if (value.detail) return readableMessage(value.detail);
    if (value.error) return readableMessage(value.error);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function updateNavStatus(aria2ok, downloads) {
  window.aria2Online = Boolean(aria2ok);
  const { dot, label, speed } = navEls;

  if (dot) dot.className = `status-dot ${aria2ok ? 'ok' : 'err'}`;
  const total = downloads.reduce((s, d) => s + (d.speed || 0), 0);
  const active = downloads.filter(d => ['downloading', 'queued'].includes(d.status)).length;
  if (label) label.textContent = aria2ok ? (active ? `${active} active` : 'idle') : 'offline';

  if (speed) {
    speed.textContent = total > 0 ? fmtSpeed(total) : '';
  }
}

function toast(msg, type = 'info') {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
  el.textContent = readableMessage(msg) || 'Request failed';
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtBytes(b, empty = '0 B') {
  b = Number(b);
  if (!isFinite(b) || b <= 0) return empty;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function fmtSpeed(bps) {
  return `${fmtBytes(bps)}/s`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function boolSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clearSettingsCache() {
  cachedSettingsPromise = null;
}

async function getSettings(force = false) {
  if (force) clearSettingsCache();
  if (!cachedSettingsPromise) cachedSettingsPromise = API.req('/api/settings');
  const settings = await cachedSettingsPromise;
  return { ...SETTINGS_DEFAULTS, ...(settings || {}) };
}

function applyInterfaceSettings(settings) {
  const scale = Math.max(85, Math.min(125, Number(settings.interface_scale || 100)));
  const browseHeight = Math.max(120, Math.min(320, Number(settings.browse_card_height || 172)));
  const libraryHeight = Math.max(120, Math.min(320, Number(settings.library_card_height || 172)));
  const ratioW = Math.max(1, Math.min(8, Number(settings.card_ratio_width || 4)));
  const ratioH = Math.max(1, Math.min(8, Number(settings.card_ratio_height || 3)));
  document.documentElement.style.fontSize = `${14 * (scale / 100)}px`;
  document.documentElement.style.setProperty('--browse-card-media-h', `${browseHeight}px`);
  document.documentElement.style.setProperty('--library-card-media-h', `${libraryHeight}px`);
  document.documentElement.style.setProperty('--card-ratio-w', String(ratioW));
  document.documentElement.style.setProperty('--card-ratio-h', String(ratioH));
  document.body.dataset.density = settings.theme_density || 'comfortable';
  document.body.dataset.reduceMotion = boolSetting(settings.reduce_motion) ? 'true' : 'false';
}

document.addEventListener('DOMContentLoaded', async () => {
  navEls = {
    dot: document.getElementById('nav-dot'),
    label: document.getElementById('nav-label'),
    speed: document.getElementById('nav-speed'),
  };

  const path = location.pathname;
  document.querySelectorAll('.nav-link').forEach(a => {
    const href = a.getAttribute('href');
    const active =
      href === path ||
      (href === '/library' && (path === '/' || path === '/library')) ||
      (href !== '/library' && path.startsWith(href));
    a.classList.toggle('active', active);
  });

  const settings = await getSettings();
  applyInterfaceSettings(settings);

  API.connectWS();
  const poll = async () => {
    if (Date.now() - API._wsSeenAt < 4000) return;
    const s = await API.req('/api/status');
    if (s) updateNavStatus(s.aria2_running, []);
  };
  poll();
  setInterval(poll, 5000);
});
