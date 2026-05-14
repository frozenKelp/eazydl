import path from 'path';
import { db, queries, type DownloadRow } from './db/database.js';
import { dm, type ProgressSnapshot } from './downloader.js';
import { cleanFilename, resolveFuckingFastDownloadInfo } from './scraper.js';
import { cleanUrl, HttpError, isPublicHttpUrl } from './security.js';
import { FUCKINGFAST_HOSTS, PROGRESS_DB_WRITE_INTERVAL_MS, START_RESOLVE_CONCURRENCY } from './config.js';

const startingDownloads = new Set<number>();
const cancelledStarts = new Set<number>();
let activeResolves = 0;
const resolveQueue: Array<() => void> = [];

const RECOVERABLE_PARTIAL_ERRORS = [
  'invalid range header',
  'no uri available',
];

export function needsFreshStart(message: string | null | undefined): boolean {
  const text = (message ?? '').toLowerCase();
  return RECOVERABLE_PARTIAL_ERRORS.some(marker => text.includes(marker));
}

function acquireResolveSlot(): Promise<void> {
  if (activeResolves < START_RESOLVE_CONCURRENCY) {
    activeResolves++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    resolveQueue.push(() => {
      activeResolves++;
      resolve();
    });
  });
}

function releaseResolveSlot(): void {
  activeResolves = Math.max(0, activeResolves - 1);
  const next = resolveQueue.shift();
  if (next) next();
}

export function releaseStartingDownload(dlId: number): void {
  startingDownloads.delete(dlId);
  cancelledStarts.delete(dlId);
}

export function cancelStartingDownload(dlId: number): void {
  if (startingDownloads.has(dlId)) cancelledStarts.add(dlId);
}

export function startWasCancelled(dlId: number): boolean {
  return cancelledStarts.has(dlId);
}

export function isStartingDownload(dlId: number): boolean {
  return startingDownloads.has(dlId);
}

function markDownloadFailed(dlId: number, message: string): void {
  if (startWasCancelled(dlId)) return;
  db.prepare<unknown, [string, number]>(
    `UPDATE downloads SET status='failed', error_message=? WHERE id=?`,
  ).run(message.slice(0, 500), dlId);
}

function safeListName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, '_').replace(/^[_. ]+|[_. ]+$/g, '') || 'default';
}

export async function resolveAndStart(
  dlId: number,
  basePath: string,
  listName: string,
  freshStart = false,
): Promise<void> {
  let actualUrl: string | null = null;
  let outputPath: string | null = null;
  let lastDbWrite = 0;

  try {
    await acquireResolveSlot();
    try {
      const dl = queries.getDownloadById.get(dlId);
      if (!dl || dl.status !== 'queued' || startWasCancelled(dlId)) return;

      try {
        const sourceUrl = await cleanUrl(dl.source_url, FUCKINGFAST_HOSTS, 'download link');
        const resolved = await resolveFuckingFastDownloadInfo(sourceUrl);
        if (!(await isPublicHttpUrl(resolved.url))) {
          throw new Error('Resolved download URL is not public HTTP(S).');
        }

        actualUrl = resolved.url;
        const filename = cleanFilename(dl.filename) ??
          cleanFilename(resolved.filename) ??
          cleanFilename(actualUrl) ??
          `file_${dlId}`;
        outputPath = path.join(basePath, safeListName(listName), filename);

        const latest = queries.getDownloadById.get(dlId);
        if (!latest || latest.status !== 'queued' || startWasCancelled(dlId)) return;
        db.prepare<unknown, [string, string, number]>(
          `UPDATE downloads SET resolved_url=?, filename=? WHERE id=?`,
        ).run(actualUrl, filename, dlId);
      } catch (err) {
        if (!startWasCancelled(dlId)) {
          const msg = err instanceof Error ? err.message : String(err);
          db.prepare<unknown, [string, number]>(
            `UPDATE downloads SET status='failed', error_message=? WHERE id=?`,
          ).run(msg.slice(0, 500), dlId);
        }
        return;
      }
    } finally {
      releaseResolveSlot();
    }

    if (!actualUrl || !outputPath) return;

    const onUpdate = async (snap: ProgressSnapshot): Promise<void> => {
      const now = Date.now();
      const isTerminal = ['completed', 'failed', 'paused'].includes(snap.status);
      if (!isTerminal && now - lastDbWrite < PROGRESS_DB_WRITE_INTERVAL_MS) return;
      lastDbWrite = now;

      db.prepare<unknown, [string, number, number, string, string, string | null, string | null, number]>(`
        UPDATE downloads
        SET status=?,
            bytes_downloaded=?,
            total_bytes=?,
            filename=COALESCE(NULLIF(?, ''), filename),
            completed_at=CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
            error_message=CASE WHEN ? IS NOT NULL THEN ? ELSE error_message END
        WHERE id=?
      `).run(
        snap.status,
        snap.bytes_downloaded,
        snap.total_bytes,
        cleanFilename(snap.filename) ?? '',
        snap.status,
        snap.error,
        snap.error?.slice(0, 500) ?? null,
        dlId,
      );
    };

    if (startWasCancelled(dlId)) return;
    await dm.enqueue(dlId, actualUrl, outputPath, onUpdate, freshStart);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Unexpected start task failure for dl_id=${dlId}:`, err);
    markDownloadFailed(dlId, msg);
  } finally {
    releaseStartingDownload(dlId);
  }
}

export async function queueDownloadStart(
  dl: DownloadRow,
  basePath: string,
  allowPaused = false,
): Promise<'queued' | 'already_running' | 'completed' | 'paused' | 'skipped'> {
  if (!dm.isRunning) throw new HttpError(503, 'aria2c is not running. See server logs.');

  let live = dm.getProgress(dl.id);
  const isStarting = startingDownloads.has(dl.id);
  let effectiveStatus = live?.status ?? dl.status;

  if (isStarting || (live && ['downloading', 'queued'].includes(effectiveStatus))) {
    return 'already_running';
  }
  if (live && ['failed', 'pending'].includes(effectiveStatus)) {
    await dm.stop(dl.id);
    live = undefined;
  }
  if (['downloading', 'queued'].includes(effectiveStatus) && !live && !isStarting) {
    effectiveStatus = 'pending';
  }
  if (effectiveStatus === 'completed') return 'completed';
  if (effectiveStatus === 'paused' && !allowPaused) return 'paused';
  if (!['pending', 'failed', 'paused'].includes(effectiveStatus)) return 'skipped';

  const freshStart = effectiveStatus === 'failed' ||
    needsFreshStart(live?.error ?? dl.error_message);

  db.prepare<unknown, [number, number]>(`
    UPDATE downloads
    SET status='queued',
        error_message=NULL,
        bytes_downloaded=CASE WHEN ? THEN 0 ELSE bytes_downloaded END
    WHERE id=?
  `).run(freshStart ? 1 : 0, dl.id);

  cancelledStarts.delete(dl.id);
  startingDownloads.add(dl.id);

  const listRow = db.prepare<{ name: string }, [number]>(
    `SELECT name FROM link_lists WHERE id=?`,
  ).get(dl.list_id);
  const listName = listRow?.name ?? 'default';

  resolveAndStart(dl.id, basePath, listName, freshStart).catch(err => {
    console.error(`resolveAndStart failed for dl_id=${dl.id}:`, err);
  });

  return 'queued';
}
