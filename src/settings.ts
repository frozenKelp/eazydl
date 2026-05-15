import { db, queries } from './db/database.js';

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
