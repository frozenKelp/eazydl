import type { FastifyInstance } from 'fastify';
import { db, queries, type DownloadRow } from '../db/database.js';
import {
  cancelStartingDownload,
  isStartingDownload,
  needsFreshStart,
  queueDownloadStart,
} from '../downloadService.js';
import { dm } from '../downloader.js';
import { cleanDownloadPath, HttpError } from '../security.js';
import { settingsSnapshot } from '../settings.js';

function uniqueIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map(item => Number(item))
      .filter(item => Number.isInteger(item) && item > 0),
  )];
}

function rowsByIds(ids: number[]): DownloadRow[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare<unknown[], DownloadRow>(
    `SELECT * FROM downloads WHERE id IN (${placeholders})`,
  ).all(...ids);
}

function emptyStartResponse(requested = 0) {
  return {
    queued: 0,
    skipped: 0,
    already_running: 0,
    requested,
    found: 0,
    queued_ids: [],
    skipped_ids: [],
    already_running_ids: [],
  };
}

export function registerDownloadRoutes(app: FastifyInstance): void {
  app.post('/api/downloads/batch/start', async (req) => {
    const ids = uniqueIds((req.body as { ids?: unknown }).ids);
    if (!ids.length) return emptyStartResponse(0);

    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');
    const rows = rowsByIds(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const queuedIds: number[] = [];
    const alreadyRunningIds: number[] = [];
    const skippedIds = ids.filter(id => !foundIds.has(id));

    for (const dl of rows) {
      const status = await queueDownloadStart(dl, basePath);
      if (status === 'queued') queuedIds.push(dl.id);
      else if (status === 'already_running') alreadyRunningIds.push(dl.id);
      else skippedIds.push(dl.id);
    }

    return {
      queued: queuedIds.length,
      skipped: skippedIds.length,
      already_running: alreadyRunningIds.length,
      requested: ids.length,
      found: rows.length,
      queued_ids: queuedIds,
      skipped_ids: skippedIds,
      already_running_ids: alreadyRunningIds,
    };
  });

  app.post('/api/downloads/batch/pause', async (req) => {
    const ids = uniqueIds((req.body as { ids?: unknown }).ids);
    const rows = rowsByIds(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const pausedIds: number[] = [];
    const skippedIds = ids.filter(id => !foundIds.has(id));

    for (const dl of rows) {
      const live = dm.getProgress(dl.id);
      const effectiveStatus = live?.status ?? dl.status;
      const wasStarting = isStartingDownload(dl.id);
      if (!['downloading', 'queued'].includes(effectiveStatus) && !wasStarting) {
        skippedIds.push(dl.id);
        continue;
      }
      cancelStartingDownload(dl.id);
      let pausedInAria = false;
      try {
        pausedInAria = await dm.pause(dl.id);
      } catch {
        skippedIds.push(dl.id);
        continue;
      }
      if (!pausedInAria && !wasStarting) {
        skippedIds.push(dl.id);
        continue;
      }
      db.prepare<[number]>(`UPDATE downloads SET status='paused' WHERE id=?`).run(dl.id);
      pausedIds.push(dl.id);
    }

    return {
      paused: pausedIds.length,
      requested: ids.length,
      paused_ids: pausedIds,
      skipped_ids: skippedIds,
    };
  });

  app.post('/api/downloads/batch/resume', async (req) => {
    const ids = uniqueIds((req.body as { ids?: unknown }).ids);
    if (!ids.length) {
      return {
        resumed: 0,
        queued: 0,
        skipped: 0,
        reset: 0,
        already_running: 0,
        requested: 0,
        found: 0,
        resumed_ids: [],
        queued_ids: [],
        skipped_ids: [],
        reset_ids: [],
        already_running_ids: [],
      };
    }

    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');
    const rows = rowsByIds(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const resumedIds: number[] = [];
    const queuedIds: number[] = [];
    const resetIds: number[] = [];
    const alreadyRunningIds: number[] = [];
    const skippedIds = ids.filter(id => !foundIds.has(id));

    for (const dl of rows) {
      const live = dm.getProgress(dl.id);
      const effectiveStatus = live?.status ?? dl.status;

      if (effectiveStatus === 'paused') {
        try {
          await dm.resume(dl.id);
          db.prepare<[number]>(`UPDATE downloads SET status='downloading' WHERE id=?`).run(dl.id);
          resumedIds.push(dl.id);
        } catch (err) {
          if (needsFreshStart(err instanceof Error ? err.message : String(err))) {
            await dm.stop(dl.id);
            db.prepare<[string, number]>(
              `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
            ).run('Resuming failed due to corrupted range data. Reset to pending.', dl.id);
            dl.status = 'failed';
            dl.bytes_downloaded = 0;
            dl.error_message = 'Resuming failed due to corrupted range data. Reset to pending.';
            const status = await queueDownloadStart(dl, basePath, true);
            if (status === 'queued') {
              queuedIds.push(dl.id);
              resetIds.push(dl.id);
            } else {
              skippedIds.push(dl.id);
            }
          } else {
            skippedIds.push(dl.id);
          }
        }
        continue;
      }

      if (['error', 'failed'].includes(effectiveStatus) &&
        needsFreshStart(live?.error ?? dl.error_message)) {
        await dm.stop(dl.id);
        db.prepare<[string, number]>(
          `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
        ).run('Reset to pending due to corrupted range data.', dl.id);
        dl.status = 'failed';
        dl.bytes_downloaded = 0;
        dl.error_message = 'Reset to pending due to corrupted range data.';
        const status = await queueDownloadStart(dl, basePath, true);
        if (status === 'queued') {
          queuedIds.push(dl.id);
          resetIds.push(dl.id);
        } else {
          skippedIds.push(dl.id);
        }
        continue;
      }

      if (['pending', 'failed'].includes(effectiveStatus)) {
        const status = await queueDownloadStart(dl, basePath, true);
        if (status === 'queued') queuedIds.push(dl.id);
        else if (status === 'already_running') alreadyRunningIds.push(dl.id);
        else skippedIds.push(dl.id);
      } else {
        skippedIds.push(dl.id);
      }
    }

    return {
      resumed: resumedIds.length,
      queued: queuedIds.length,
      skipped: skippedIds.length,
      reset: resetIds.length,
      already_running: alreadyRunningIds.length,
      requested: ids.length,
      found: rows.length,
      resumed_ids: resumedIds,
      queued_ids: queuedIds,
      skipped_ids: skippedIds,
      reset_ids: resetIds,
      already_running_ids: alreadyRunningIds,
    };
  });

  app.post('/api/downloads/:dl_id/start', async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const id = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(id);
    if (!dl) throw new HttpError(404, 'Download not found.');
    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');
    const status = await queueDownloadStart(dl, basePath);
    if (status === 'queued') return { status: 'queued' };
    if (status === 'already_running') throw new HttpError(400, 'Already running.');
    if (status === 'paused') throw new HttpError(400, 'Use resume for paused downloads.');
    if (status === 'completed') throw new HttpError(400, 'Download is already completed.');
    throw new HttpError(400, 'Download cannot be started.');
  });

  app.post('/api/downloads/:dl_id/pause', async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const id = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(id);
    if (!dl) throw new HttpError(404, 'Download not found.');
    const live = dm.getProgress(id);
    const effectiveStatus = live?.status ?? dl.status;
    const wasStarting = isStartingDownload(id);
    if (!['downloading', 'queued'].includes(effectiveStatus) && !wasStarting) {
      throw new HttpError(400, 'Download is not running.');
    }
    cancelStartingDownload(id);
    const pausedInAria = await dm.pause(id);
    if (!pausedInAria && !wasStarting) throw new HttpError(409, 'Download is no longer tracked by aria2c.');
    db.prepare<[number]>(`UPDATE downloads SET status='paused' WHERE id=?`).run(id);
    return { status: 'paused' };
  });

  app.post('/api/downloads/:dl_id/resume', async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const id = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(id);
    if (!dl) throw new HttpError(404, 'Download not found.');
    const live = dm.getProgress(id);
    const effectiveStatus = live?.status ?? dl.status;
    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');

    if (effectiveStatus === 'paused') {
      try {
        await dm.resume(id);
        db.prepare<[number]>(`UPDATE downloads SET status='downloading' WHERE id=?`).run(id);
        return { status: 'resumed' };
      } catch (err) {
        if (needsFreshStart(err instanceof Error ? err.message : String(err))) {
          await dm.stop(id);
          db.prepare<[string, number]>(
            `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
          ).run('Resuming failed due to corrupted range data. Reset to pending.', id);
          dl.status = 'failed';
          dl.bytes_downloaded = 0;
          dl.error_message = 'Resuming failed due to corrupted range data. Reset to pending.';
          const status = await queueDownloadStart(dl, basePath, true);
          if (status === 'queued') return { status: 'queued', reset: true };
          return { status: 'reset', error: err instanceof Error ? err.message : String(err) };
        }
        throw err;
      }
    }

    if (['error', 'failed'].includes(effectiveStatus) &&
      needsFreshStart(live?.error ?? dl.error_message)) {
      await dm.stop(id);
      db.prepare<[string, number]>(
        `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
      ).run('Reset to pending due to corrupted range data.', id);
      dl.status = 'failed';
      dl.bytes_downloaded = 0;
      dl.error_message = 'Reset to pending due to corrupted range data.';
      const status = await queueDownloadStart(dl, basePath, true);
      if (status === 'queued') return { status: 'queued', reset: true };
      return { status: 'reset' };
    }

    const status = await queueDownloadStart(dl, basePath, true);
    if (status === 'queued') return { status: 'queued' };
    if (status === 'already_running') return { status: 'already_running' };
    if (status === 'completed') throw new HttpError(400, 'Download is already completed.');
    throw new HttpError(400, 'Download cannot be resumed.');
  });

  app.post('/api/downloads/:dl_id/stop', async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const id = Number.parseInt(dl_id, 10);
    cancelStartingDownload(id);
    await dm.stop(id);
    db.prepare<[number]>(`UPDATE downloads SET status='pending' WHERE id=?`).run(id);
    return { status: 'stopped' };
  });

  app.delete('/api/downloads/:dl_id', async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const id = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(id);
    if (!dl) throw new HttpError(404, 'Download not found.');
    cancelStartingDownload(id);
    await dm.stop(id);
    db.prepare<[number]>(`DELETE FROM downloads WHERE id=?`).run(id);
    return { status: 'deleted' };
  });
}
