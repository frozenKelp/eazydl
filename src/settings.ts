import { db, queries } from './db/database.js';
import { cleanDownloadPath, HttpError } from './security.js';

let cache: Record<string, string> = {};

export function loadSettingsCache(): Record<string, string> {
  const rows = queries.getAllSettings.all();
  cache = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return { ...cache };
}

export function settingsSnapshot(): Record<string, string> {
  if (Object.keys(cache).length > 0) return { ...cache };
  return loadSettingsCache();
}

export function persistSettings(values: Record<string, string>): Record<string, string> {
  const upsert = db.transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) queries.upsertSetting.run(key, value);
  });
  upsert(Object.entries(values));
  cache = { ...cache, ...values };
  return { ...cache };
}

const ALLOWED_SETTINGS = new Set([
  'download_path',
  'max_concurrent',
  'connections_per_file',
  'auto_start_new_games',
  'browse_items_per_page',
  'browse_card_size',
  'browse_show_descriptions',
  'browse_open_links_new_tab',
  'library_card_size',
  'library_default_detail',
  'library_show_file_urls',
  'confirm_delete',
  'interface_scale',
  'theme_density',
  'reduce_motion',
]);

const INT_RANGES: Record<string, [number, number]> = {
  max_concurrent: [1, 32],
  connections_per_file: [1, 16],
  browse_items_per_page: [6, 60],
  interface_scale: [85, 125],
};

const CHOICE_SETTINGS: Record<string, Set<string>> = {
  browse_card_size: new Set(['compact', 'medium', 'large']),
  library_card_size: new Set(['compact', 'medium', 'large']),
  theme_density: new Set(['compact', 'comfortable', 'spacious']),
};

const BOOL_SETTINGS = new Set([
  'auto_start_new_games',
  'browse_show_descriptions',
  'browse_open_links_new_tab',
  'library_default_detail',
  'library_show_file_urls',
  'confirm_delete',
  'reduce_motion',
]);

export function normaliseBool(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return 'true';
  if (['0', 'false', 'no', 'off'].includes(text)) return 'false';
  throw new Error('expected boolean');
}

export function normaliseSettings(data: Record<string, unknown>): Record<string, string> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'Settings payload must be an object.');
  }

  const unknown = Object.keys(data).filter(key => !ALLOWED_SETTINGS.has(key)).sort();
  if (unknown.length) {
    throw new HttpError(400, `Unsupported setting(s): ${unknown.join(', ')}`);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key in INT_RANGES) {
      const n = Number.parseInt(String(value), 10);
      if (Number.isNaN(n)) throw new HttpError(400, `${key} must be an integer.`);
      const [lo, hi] = INT_RANGES[key];
      if (n < lo || n > hi) throw new HttpError(400, `${key} must be between ${lo} and ${hi}.`);
      out[key] = String(n);
    } else if (BOOL_SETTINGS.has(key)) {
      try {
        out[key] = normaliseBool(value);
      } catch {
        throw new HttpError(400, `${key} must be a boolean.`);
      }
    } else if (key in CHOICE_SETTINGS) {
      const text = String(value ?? '').trim();
      if (!CHOICE_SETTINGS[key].has(text)) {
        throw new HttpError(400, `${key} must be one of: ${[...CHOICE_SETTINGS[key]].sort().join(', ')}.`);
      }
      out[key] = text;
    } else if (key === 'download_path') {
      out[key] = cleanDownloadPath(String(value ?? ''));
    } else {
      out[key] = String(value ?? '').trim();
    }
  }
  return out;
}
