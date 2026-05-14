import path from 'path';

export const BASE_DIR = import.meta.dir;
export const PROJECT_ROOT = path.resolve(BASE_DIR, '..');
export const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'downloads');

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PROGRESS_DB_WRITE_INTERVAL_MS = 5000;
export const START_RESOLVE_CONCURRENCY = 4;

export const FITGIRL_HOSTS = new Set(['fitgirl-repacks.site', 'www.fitgirl-repacks.site']);
export const FUCKINGFAST_HOSTS = new Set(['fuckingfast.co', 'www.fuckingfast.co']);
