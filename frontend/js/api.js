/**
 * api.js — Shared utilities for EasyDL.
 * Loaded on every page. Provides:
 *   - API.req(url, method, body)  — fetch wrapper with toast on error
 *   - API.onProgress(cb)         — register a WebSocket progress callback
 *   - toast(msg, type)
 *   - fmtBytes(n), fmtSpeed(bps)
 *   - esc(s)                     — HTML-escape a string
 *   - updateNavStatus(ok, data)  — update aria2c badge + global speed
 */

const API = {
  _ws: null,
  _callbacks: [],

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
      toast('Network error — is the server running?', 'err');
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
        updateNavStatus(msg.aria2_ok, msg.data || []);
        this._callbacks.forEach(cb => cb(msg));
      } catch { /* malformed message */ }
    };

    this._ws.onclose = () => setTimeout(() => this.connectWS(), 3000);
    this._ws.onerror = () => this._ws.close();
  },

  onProgress(cb) {
    this._callbacks.push(cb);
  },
};

/* ── Nav status ─────────────────────────────────────── */
function updateNavStatus(aria2ok, downloads) {
  const dot   = document.getElementById('nav-dot');
  const label = document.getElementById('nav-label');
  const speed = document.getElementById('nav-speed');

  if (dot)   dot.className = `status-dot ${aria2ok ? 'ok' : 'err'}`;
  if (label) label.textContent = aria2ok ? 'aria2c' : 'offline';

  if (speed) {
    const total = downloads.reduce((s, d) => s + (d.speed || 0), 0);
    speed.textContent = total > 0 ? '↓ ' + fmtSpeed(total) : '';
  }
}

/* ── Toast ──────────────────────────────────────────── */
function toast(msg, type = 'info') {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    document.body.appendChild(c);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info'}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ── Formatters ─────────────────────────────────────── */
function fmtBytes(b) {
  b = Number(b);
  if (!isFinite(b) || b <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

function fmtSpeed(bps) { return fmtBytes(bps) + '/s'; }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Nav init (runs on every page) ─────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Highlight active nav link
  const path = location.pathname;
  document.querySelectorAll('.nav-link').forEach(a => {
    const href = a.getAttribute('href');
    const active =
      href === path ||
      (href === '/library' && (path === '/' || path === '/library')) ||
      (href !== '/library' && path.startsWith(href));
    a.classList.toggle('active', active);
  });

  // Start WebSocket + periodic aria2c poll
  API.connectWS();
  const poll = async () => {
    const s = await API.req('/api/status');
    if (s) updateNavStatus(s.aria2_running, []);
  };
  poll();
  setInterval(poll, 5000);
});