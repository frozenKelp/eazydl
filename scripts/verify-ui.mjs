import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const port = process.env.EASYDL_VERIFY_PORT || '8123';
const baseUrl = `http://127.0.0.1:${port}`;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const server = spawn('bun', ['src/index.ts'], {
  cwd: repoRoot,
  env: { ...process.env, EASYDL_HOST: '127.0.0.1', EASYDL_PORT: port },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
server.stdout.on('data', chunk => {
  output += chunk.toString();
});
server.stderr.on('data', chunk => {
  output += chunk.toString();
});

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return;
    } catch {
      // Keep waiting until the server is ready or the deadline expires.
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Server did not start on ${baseUrl}\n${output}`);
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function checkPage(browser, path, viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 15000 });
  const result = await page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    };
    return {
      bodyOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      nav: rect('.side-nav'),
      settingsActions: rect('.settings-actions'),
      saveButton: rect('.settings-actions .btn-primary'),
      hasMainPane: Boolean(document.querySelector('.main-pane, .settings-shell')),
    };
  });
  await page.close();

  if (result.bodyOverflow) throw new Error(`${path} overflows horizontally at ${viewport.width}px.`);
  if (!result.hasMainPane) throw new Error(`${path} did not render its main surface.`);
  if (viewport.width <= 860 && path === '/settings' && overlaps(result.saveButton, result.nav)) {
    throw new Error('Settings save button overlaps navigation.');
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }]) {
      await checkPage(browser, '/library', viewport);
      await checkPage(browser, '/settings', viewport);
      await checkPage(browser, '/browse', viewport);
    }
  } finally {
    await browser.close();
  }
  console.log('UI verification passed.');
} finally {
  server.kill('SIGTERM');
}
