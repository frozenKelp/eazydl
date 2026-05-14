import fs from 'fs';
import { DATA_DIR, DOWNLOADS_DIR } from './config.js';

export function ensureDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}
