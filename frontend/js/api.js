const SETTINGS_DEFAULTS = {
  browse_items_per_page: '24',
  browse_card_size: 'medium',
  library_card_size: 'medium',
  library_default_detail: 'false',
  library_show_file_urls: 'true',
  confirm_delete: 'true',
  interface_scale: '100',
  theme_density: 'comfortable',
  reduce_motion: 'false',
};

const API = {
  _ws: null,
  _callbacks: [],
  _wsSeenAt: 0,

  async req(url, method = 'GET', body = null) {
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== null) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        toast(err.detail || `Request failed (${res.status})`, 'err');
        return null;
      }
      return await res.json();
    } catch {
      toast('Network error. Is the server running?', 'err');
      return null;
    }
  },

  connectWS() {
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

    this._ws.onclose = () => setTimeout(() => this.connectWS(), 3000);
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
  const dot = document.getElementById('nav-dot');
  const label = document.getElementById('nav-label');
  const speed = document.getElementById('nav-speed');

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

async function getSettings() {
  const settings = await API.req('/api/settings');
  return { ...SETTINGS_DEFAULTS, ...(settings || {}) };
}

function applyInterfaceSettings(settings) {
  const scale = Math.max(85, Math.min(125, Number(settings.interface_scale || 100)));
  document.documentElement.style.fontSize = `${14 * (scale / 100)}px`;
  document.body.dataset.density = settings.theme_density || 'comfortable';
  document.body.dataset.reduceMotion = boolSetting(settings.reduce_motion) ? 'true' : 'false';
}

document.addEventListener('DOMContentLoaded', async () => {
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
