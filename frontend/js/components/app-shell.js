class EasyShell extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready === 'true') return;
    this.dataset.ready = 'true';

    const page = this.getAttribute('page') || 'library';
    const label = this.getAttribute('label') || page;
    const meta = this.getAttribute('meta') || '';
    const icon = this.getAttribute('icon') || page;
    const actions = this.querySelector('template[data-shell-actions]')?.innerHTML || '';
    const content = [...this.children]
      .filter(child => !child.matches('template[data-shell-actions]'))
      .map(child => child.outerHTML)
      .join('');

    this.innerHTML = `
      <div class="app-shell">
        <nav class="side-nav" aria-label="Primary navigation">
          <a class="nav-logo" href="/library" aria-label="EasyDL library">
            <span class="nav-logo-icon">ED</span>
            <span class="brand-copy">
              <span class="brand-name">EasyDL</span>
              <span class="brand-subtitle">local download workspace</span>
            </span>
          </a>

          <div class="nav-section-title">Workspace</div>
          <div class="nav-links">
            ${this.navLink('/library', 'library', 'Library')}
            ${this.navLink('/browse', 'browse', 'Browse')}
            ${this.navLink('/settings', 'settings', 'Settings')}
          </div>

          <div class="nav-section-title">Quick Access</div>
          <div class="quick-links" aria-label="Quick access">
            <a class="quick-link" href="/library"><span class="icon icon-path" aria-hidden="true"></span><span>Saved games</span></a>
            <a class="quick-link" href="/browse"><span class="icon icon-browse" aria-hidden="true"></span><span>FitGirl index</span></a>
          </div>

          <div class="nav-spacer"></div>

          <div class="nav-status">
            <div class="status-caption"><span>aria2c</span><span id="nav-speed" class="nav-speed" aria-live="polite"></span></div>
            <div class="aria2-pill"><span id="nav-dot" class="status-dot"></span><span id="nav-label">checking</span></div>
          </div>
        </nav>

        <section class="app-workspace">
          <header class="topbar">
            <div class="tab-strip" aria-label="Open tabs">
              ${this.navLink('/library', 'library', 'Library', 'tab-link')}
              ${this.navLink('/browse', 'browse', 'Browse', 'tab-link')}
              ${this.navLink('/settings', 'settings', 'Settings', 'tab-link')}
            </div>
            <div class="command-row">
              <div class="address-bar" aria-label="Current location">
                <span class="icon icon-path" aria-hidden="true"></span>
                <span class="address-seg">EasyDL</span>
                <span class="address-seg">/</span>
                <strong>${this.escape(label)}</strong>
              </div>
              ${actions || `<div class="pane-meta">${this.escape(meta)}</div>`}
            </div>
          </header>
          ${content}
        </section>
      </div>`;

    this.querySelectorAll(`[data-shell-page="${page}"]`).forEach(link => link.classList.add('active'));
  }

  navLink(href, page, label, extra = '') {
    return `<a class="nav-link ${extra}" data-shell-page="${page}" href="${href}">
      <span class="icon icon-${page}" aria-hidden="true"></span><span>${label}</span>
    </a>`;
  }

  escape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

customElements.define('easy-shell', EasyShell);
