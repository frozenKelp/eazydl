import fs from 'fs';
import path from 'path';
import { DATA_DIR, DOWNLOADS_DIR } from '../config.js';
import { SqliteDatabase } from './sqlite.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'downloader.db');

export const db = new SqliteDatabase(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export interface LinkListRow {
  id: number;
  name: string;
  source_url: string | null;
  image_url: string | null;
  description: string | null;
  size: string | null;
  categories: string | null;
  created_at: string | null;
}

export interface DownloadRow {
  id: number;
  list_id: number;
  source_url: string;
  resolved_url: string | null;
  filename: string;
  status: string;
  bytes_downloaded: number;
  total_bytes: number;
  created_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface SettingRow {
  key: string;
  value: string;
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_lists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    UNIQUE NOT NULL,
      source_url  TEXT,
      image_url   TEXT,
      description TEXT,
      size        TEXT,
      categories  TEXT,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id           INTEGER REFERENCES link_lists(id) ON DELETE CASCADE,
      source_url        TEXT NOT NULL,
      resolved_url      TEXT,
      filename          TEXT DEFAULT '',
      status            TEXT DEFAULT 'pending',
      bytes_downloaded  INTEGER DEFAULT 0,
      total_bytes       INTEGER DEFAULT 0,
      created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at      TEXT,
      error_message     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_downloads_status
      ON downloads (status);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  runMigrations();
  createDownloadUniqueIndex();
  resetInFlightDownloads();
  seedDefaultSettings();
  normaliseSizePrefixes();
}

function runMigrations(): void {
  const existingCols = new Set(
    (db.pragma('table_info(link_lists)') as Array<{ name: string }>).map(r => r.name),
  );
  const needed: Record<string, string> = {
    source_url: 'TEXT',
    image_url: 'TEXT',
    description: 'TEXT',
    size: 'TEXT',
    categories: 'TEXT',
  };

  for (const [col, type] of Object.entries(needed)) {
    if (!existingCols.has(col)) {
      db.exec(`ALTER TABLE link_lists ADD COLUMN ${col} ${type}`);
    }
  }
}

function createDownloadUniqueIndex(): void {
  const deleteDuplicates = db.prepare(`
    DELETE FROM downloads
    WHERE id NOT IN (
      SELECT MIN(id) FROM downloads GROUP BY list_id, source_url
    )
  `);
  const createIndex = db.transaction(() => {
    deleteDuplicates.run();
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_downloads_list_source
      ON downloads (list_id, source_url)
    `);
  });
  createIndex();
}

function resetInFlightDownloads(): void {
  db.prepare(`
    UPDATE downloads
    SET status = 'pending'
    WHERE status IN ('downloading', 'queued', 'paused')
  `).run();
}

function normaliseSizePrefixes(): void {
  db.prepare(`
    UPDATE link_lists
    SET size = substr(size, 6)
    WHERE lower(substr(size, 1, 5)) = 'from '
  `).run();
}

function seedDefaultSettings(): void {
  const defaults: Record<string, string> = {
    download_path: DOWNLOADS_DIR,
    max_concurrent: '3',
    connections_per_file: '4',
    auto_start_new_games: 'false',
    browse_items_per_page: '24',
    browse_card_size: 'medium',
    browse_show_descriptions: 'true',
    browse_open_links_new_tab: 'true',
    library_card_size: 'medium',
    library_default_detail: 'false',
    library_show_file_urls: 'true',
    confirm_delete: 'true',
    interface_scale: '100',
    theme_density: 'comfortable',
    reduce_motion: 'false',
  };
  const insert = db.prepare<[string, string]>(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  const insertMany = db.transaction((entries: [string, string][]) => {
    for (const [key, value] of entries) insert.run(key, value);
  });
  insertMany(Object.entries(defaults));
}

export const queries = {
  getLists: db.prepare<[], LinkListRow>(
    `SELECT * FROM link_lists ORDER BY created_at DESC`,
  ),
  getListById: db.prepare<[number], LinkListRow>(
    `SELECT * FROM link_lists WHERE id = ?`,
  ),
  getListByName: db.prepare<[string], LinkListRow>(
    `SELECT * FROM link_lists WHERE name = ?`,
  ),
  getDownloadsForList: db.prepare<[number], DownloadRow>(
    `SELECT * FROM downloads WHERE list_id = ? ORDER BY created_at ASC`,
  ),
  getDownloadById: db.prepare<[number], DownloadRow>(
    `SELECT * FROM downloads WHERE id = ?`,
  ),
  getAllSettings: db.prepare<[], SettingRow>(
    `SELECT * FROM settings`,
  ),
  getSetting: db.prepare<[string], SettingRow>(
    `SELECT * FROM settings WHERE key = ?`,
  ),
  upsertSetting: db.prepare<[string, string]>(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ),
};
