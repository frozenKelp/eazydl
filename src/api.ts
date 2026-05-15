import type { FastifyInstance } from 'fastify';
import { db, queries, type DownloadRow, type LinkListRow } from './db/database.js';
import { aria2, type ProgressSnapshot } from './aria2-service.js';
import { cleanFilename, getFitgirlGameDetails, getFuckingFastDownloads, getFuckingFastLinks, searchFitgirl } from './scraper.js';
import { cleanDownloadPath, cleanUrl, HttpError, isPublicHttpUrl } from './security.js';
import { FUCKINGFAST_HOSTS, FITGIRL_HOSTS, MAX_IMAGE_BYTES } from './config.js';
import { persistSettings, settingsSnapshot } from './settings.js';

// Inline serializers
function downloadToDict(d: DownloadRow): Record<string, unknown> {
  const live = aria2.getProgress(d.id);
  const bytesDownloaded = live?.bytes_downloaded ?? d.bytes_downloaded ?? 0;
  const totalBytes = live?.total_bytes ?? d.total_bytes ?? 0;
  const status = live?.status ?? d.status;
  return {
    id: d.id,
    url: d.source_url,
    filename: cleanFilename(d.filename) ??
      cleanFilename(live?.filename) ??
      d.filename ??
      live?.filename ??
      '',
    status,
    bytes_downloaded: bytesDownloaded,
    total_bytes: totalBytes,
    progress: live?.progress ?? (totalBytes ? bytesDownloaded / totalBytes * 100 : 0),
    speed: live?.speed ?? 0,
    connections: live?.connections ?? 0,
    gid: live?.gid ?? d.gid ?? '',
    error_message: live?.error ?? (status === 'failed' ? d.error_message : '') ?? '',
  };
}

function listToDict(
  lst: LinkListRow,
  rows: DownloadRow[] = [],
  includeDownloads = false,
): Record<string, unknown> {
  const downloads = rows.map(downloadToDict);
  const totalBytes = downloads.reduce((sum, d) => sum + Number(d.total_bytes ?? 0), 0);
  const bytesDownloaded = downloads.reduce((sum, d) => sum + Number(d.bytes_downloaded ?? 0), 0);
  const completed = downloads.filter(d => d.status === 'completed').length;
  const data: Record<string, unknown> = {
    id: lst.id,
    name: lst.name,
    source_url: lst.source_url ?? '',
    image_url: lst.image_url ?? '',
    size: lst.size ?? '',
    categories: (lst.categories ?? '').split('|').filter(Boolean),
    created_at: lst.created_at,
    count: rows.length,
    completed,
    dl_ids: rows.map(d => d.id),
    total_bytes: totalBytes,
    bytes_downloaded: bytesDownloaded,
  };
  if (includeDownloads) data.downloads = downloads;
  return data;
}

function groupedDownloads(): Map<number, DownloadRow[]> {
  const groups = new Map<number, DownloadRow[]>();
  for (const row of queries.getAllDownloads.all()) {
    const rows = groups.get(row.list_id) ?? [];
    rows.push(row);
    groups.set(row.list_id, rows);
  }
  return groups;
}

function listsPayload(includeDownloads = false): Record<string, unknown>[] {
  const groups = groupedDownloads();
  return queries.getLists.all().map(list => listToDict(list, groups.get(list.id) ?? [], includeDownloads));
}

// Helpers
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
  return db.prepare<DownloadRow, number[]>(
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

function markDownloadPending(dlId: number): void {
  db.prepare<unknown, [number]>(`
    UPDATE downloads
    SET status='pending',
        gid=NULL,
        bytes_downloaded=0,
        total_bytes=0,
        completed_at=NULL,
        error_message=NULL
    WHERE id=?
  `).run(dlId);
}

const idArrayBodySchema = {
  type: 'object',
  required: ['ids'],
  additionalProperties: false,
  properties: {
    ids: {
      type: 'array',
      minItems: 0,
      maxItems: 500,
      items: {
        anyOf: [
          { type: 'integer', minimum: 1 },
          { type: 'string', pattern: '^\\d+$' },
        ],
      },
    },
  },
};

const listIdParamSchema = {
  type: 'object',
  required: ['list_id'],
  properties: {
    list_id: { type: 'string', pattern: '^\\d+$' },
  },
};

const downloadIdParamSchema = {
  type: 'object',
  required: ['dl_id'],
  properties: {
    dl_id: { type: 'string', pattern: '^\\d+$' },
  },
};

export function registerApiRoutes(app: FastifyInstance): void {
  // === LIBRARY ROUTES ===
  app.get('/api/lists', () => {
    return listsPayload(false);
  });

  app.get('/api/library', () => {
    return { lists: listsPayload(true) };
  });

  app.post('/api/lists', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  }, (req, reply) => {
    const body = req.body as { name: string };
    const name = body.name.trim();
    if (!name) throw new HttpError(400, 'List name cannot be empty.');
    if (queries.getListByName.get(name)) throw new HttpError(400, 'A list with that name already exists.');
    const result = db.prepare<unknown, [string]>(`INSERT INTO link_lists (name) VALUES (?)`).run(name);
    return reply.status(201).send({ id: result.lastInsertRowid, name });
  });

  app.delete('/api/lists/:list_id', {
    schema: { params: listIdParamSchema },
  }, async (req) => {
    const { list_id } = req.params as { list_id: string };
    const id = Number.parseInt(list_id, 10);
    const list = queries.getListById.get(id);
    if (!list) throw new HttpError(404, 'List not found.');
    for (const dl of queries.getDownloadsForList.all(list.id)) {
      aria2.cancelStartingDownload(dl.id);
      await aria2.stop(dl.id);
    }
    db.prepare<unknown, [number]>(`DELETE FROM link_lists WHERE id=?`).run(list.id);
    return { status: 'deleted' };
  });

  app.get('/api/lists/:list_id/downloads', {
    schema: { params: listIdParamSchema },
  }, (req) => {
    const { list_id } = req.params as { list_id: string };
    const id = Number.parseInt(list_id, 10);
    if (!queries.getListById.get(id)) throw new HttpError(404, 'List not found.');
    return queries.getDownloadsForList.all(id).map(downloadToDict);
  });

  app.post('/api/lists/:list_id/links', {
    schema: {
      params: listIdParamSchema,
      body: {
        type: 'object',
        required: ['urls'],
        additionalProperties: false,
        properties: {
          urls: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: { type: 'string', minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
  }, async (req) => {
    const { list_id } = req.params as { list_id: string };
    const body = req.body as { urls?: string[] };
    const id = Number.parseInt(list_id, 10);
    if (!queries.getListById.get(id)) throw new HttpError(404, 'List not found.');
    const urls = Array.isArray(body.urls) ? body.urls : [];
    const existing = new Set(
      db.prepare<{ source_url: string }, [number]>(
        `SELECT source_url FROM downloads WHERE list_id=?`,
      ).all(id).map(row => row.source_url),
    );
    const insert = db.prepare<unknown, [number, string]>(
      `INSERT OR IGNORE INTO downloads (list_id, source_url, status) VALUES (?, ?, 'pending')`,
    );

    let added = 0;
    for (const raw of urls) {
      if (!String(raw ?? '').trim()) continue;
      const url = await cleanUrl(raw, FUCKINGFAST_HOSTS, 'download link');
      if (existing.has(url)) continue;
      const result = insert.run(id, url);
      existing.add(url);
      if (result.changes > 0) added++;
    }
    return { submitted: urls.length, added };
  });

  app.post('/api/games', {
    schema: {
      body: {
        type: 'object',
        required: ['title', 'game_url'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          game_url: { type: 'string', minLength: 1, maxLength: 2048 },
          image_url: { type: 'string', maxLength: 2048 },
          size: { type: 'string', maxLength: 120 },
          categories: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as {
      title?: string;
      game_url?: string;
      image_url?: string;
      size?: string;
      categories?: string[];
    };
    const title = (body.title ?? '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Title is required.');
    const gameUrl = await cleanUrl(body.game_url ?? '', FITGIRL_HOSTS, 'FitGirl URL');

    let list = queries.getListByName.get(title);
    if (!list) {
      const result = db.prepare<unknown, [string]>(`INSERT INTO link_lists (name) VALUES (?)`).run(title);
      list = queries.getListById.get(Number(result.lastInsertRowid));
    }
    if (!list) throw new HttpError(500, 'Could not create library item.');

    const categories = (body.categories ?? []).map(cat => cat.trim()).filter(Boolean);
    const size = (body.size ?? '').replace(/^from\s+/i, '').trim().slice(0, 80);
    if (gameUrl && !list.source_url) {
      db.prepare<unknown, [string, number]>(`UPDATE link_lists SET source_url=? WHERE id=?`).run(gameUrl, list.id);
    }
    if (body.image_url && !list.image_url) {
      db.prepare<unknown, [string, number]>(`UPDATE link_lists SET image_url=? WHERE id=?`).run(body.image_url.trim(), list.id);
    }
    if (size && !list.size) {
      db.prepare<unknown, [string, number]>(`UPDATE link_lists SET size=? WHERE id=?`).run(size, list.id);
    }
    if (categories.length && !list.categories) {
      db.prepare<unknown, [string, number]>(`UPDATE link_lists SET categories=? WHERE id=?`).run(categories.slice(0, 12).join('|'), list.id);
    }

    let downloads: Array<{ url: string; filename: string | null }>;
    try {
      downloads = await getFuckingFastDownloads(gameUrl);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }

    const existingRows = new Map<string, DownloadRow>(
      queries.getDownloadsForList.all(list.id).map(dl => [dl.source_url, dl]),
    );
    const alreadyHad = existingRows.size;
    const insert = db.prepare<unknown, [number, string, string]>(
      `INSERT OR IGNORE INTO downloads (list_id, source_url, filename, status) VALUES (?, ?, ?, 'pending')`,
    );
    const updateFilename = db.prepare<unknown, [string, number]>(
      `UPDATE downloads SET filename=? WHERE id=?`,
    );

    let added = 0;
    const addedIds: number[] = [];
    const downloadIds: number[] = [];
    for (const item of downloads) {
      const url = await cleanUrl(item.url, FUCKINGFAST_HOSTS, 'download link');
      const filename = cleanFilename(item.filename) ?? '';
      const existing = existingRows.get(url);
      if (existing) {
        if (filename && !existing.filename) updateFilename.run(filename, existing.id);
        downloadIds.push(existing.id);
        continue;
      }

      const result = insert.run(list.id, url, filename);
      if (result.changes > 0) {
        const id = Number(result.lastInsertRowid);
        added++;
        addedIds.push(id);
        downloadIds.push(id);
        existingRows.set(url, {
          id,
          list_id: list.id,
          source_url: url,
          resolved_url: null,
          gid: null,
          filename,
          status: 'pending',
          bytes_downloaded: 0,
          total_bytes: 0,
          created_at: null,
          completed_at: null,
          error_message: null,
        });
      }
    }

    return reply.status(201).send({
      id: list.id,
      title,
      found: downloads.length,
      added,
      already_had: alreadyHad,
      download_ids: downloadIds,
      added_ids: addedIds,
    });
  });

  // === DOWNLOAD ROUTES ===
  app.post('/api/downloads/batch/start', {
    schema: { body: idArrayBodySchema },
  }, async (req) => {
    const ids = uniqueIds((req.body as { ids?: unknown }).ids);
    if (!ids.length) return emptyStartResponse(0);

    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');
    const rows = rowsByIds(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const queuedIds: number[] = [];
    const alreadyRunningIds: number[] = [];
    const skippedIds = ids.filter(id => !foundIds.has(id));

    for (const dl of rows) {
      const status = await aria2.queueDownloadStart(dl, basePath);
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

  app.post('/api/downloads/batch/pause', {
    schema: { body: idArrayBodySchema },
  }, async (req) => {
    const ids = uniqueIds((req.body as { ids?: unknown }).ids);
    const rows = rowsByIds(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const pausedIds: number[] = [];
    const skippedIds = ids.filter(id => !foundIds.has(id));

    for (const dl of rows) {
      const live = aria2.getProgress(dl.id);
      const effectiveStatus = live?.status ?? dl.status;
      const wasStarting = aria2.isStartingDownload(dl.id);
      if (!['downloading', 'queued'].includes(effectiveStatus) && !wasStarting) {
        skippedIds.push(dl.id);
        continue;
      }

      aria2.cancelStartingDownload(dl.id);
      try {
        const pausedInAria = await aria2.pause(dl.id);
        if (!pausedInAria && !wasStarting) {
          skippedIds.push(dl.id);
          continue;
        }
        db.prepare<unknown, [number]>(`UPDATE downloads SET status='paused' WHERE id=?`).run(dl.id);
        pausedIds.push(dl.id);
      } catch {
        skippedIds.push(dl.id);
      }
    }

    return { paused: pausedIds.length, requested: ids.length, paused_ids: pausedIds, skipped_ids: skippedIds };
  });

  app.post('/api/downloads/batch/resume', {
    schema: { body: idArrayBodySchema },
  }, async (req) => {
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
      const live = aria2.getProgress(dl.id);
      const effectiveStatus = live?.status ?? dl.status;

      if (effectiveStatus === 'paused') {
        try {
          const resumed = await aria2.resume(dl.id);
          if (resumed) {
            db.prepare<unknown, [number]>(`UPDATE downloads SET status='downloading' WHERE id=?`).run(dl.id);
            resumedIds.push(dl.id);
          } else {
            const status = await aria2.queueDownloadStart(dl, basePath, true);
            if (status === 'queued') queuedIds.push(dl.id);
            else if (status === 'already_running') alreadyRunningIds.push(dl.id);
            else skippedIds.push(dl.id);
          }
        } catch (err) {
          if (aria2.needsFreshStart(err instanceof Error ? err.message : String(err))) {
            await aria2.stop(dl.id);
            db.prepare<unknown, [string, number]>(
              `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
            ).run('Resuming failed due to corrupted range data. Reset to pending.', dl.id);
            dl.status = 'failed';
            dl.bytes_downloaded = 0;
            dl.error_message = 'Resuming failed due to corrupted range data. Reset to pending.';
            const status = await aria2.queueDownloadStart(dl, basePath, true);
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
        aria2.needsFreshStart(live?.error ?? dl.error_message)) {
        await aria2.stop(dl.id);
        db.prepare<unknown, [string, number]>(
          `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
        ).run('Reset to pending due to corrupted range data.', dl.id);
        dl.status = 'failed';
        dl.bytes_downloaded = 0;
        dl.error_message = 'Reset to pending due to corrupted range data.';
        const status = await aria2.queueDownloadStart(dl, basePath, true);
        if (status === 'queued') {
          queuedIds.push(dl.id);
          resetIds.push(dl.id);
        } else {
          skippedIds.push(dl.id);
        }
        continue;
      }

      if (['pending', 'failed'].includes(effectiveStatus)) {
        const status = await aria2.queueDownloadStart(dl, basePath, true);
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

  app.post('/api/downloads/batch/stop', {
    schema: { body: idArrayBodySchema },
  }, async (req) => {
    const ids = uniqueIds((req.body as { ids?: unknown }).ids);
    const rows = rowsByIds(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const stoppedIds: number[] = [];
    const skippedIds = ids.filter(id => !foundIds.has(id));

    for (const dl of rows) {
      aria2.cancelStartingDownload(dl.id);
      await aria2.stop(dl.id);
      markDownloadPending(dl.id);
      stoppedIds.push(dl.id);
    }

    return { stopped: stoppedIds.length, skipped: skippedIds.length, stopped_ids: stoppedIds, skipped_ids: skippedIds };
  });

  app.post('/api/downloads/:dl_id/start', {
    schema: { params: downloadIdParamSchema },
  }, async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const dlId = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(dlId);
    if (!dl) throw new HttpError(404, 'Download not found.');
    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');
    const status = await aria2.queueDownloadStart(dl, basePath);
    if (status === 'queued') return { status: 'queued' };
    if (status === 'already_running') throw new HttpError(400, 'Already running.');
    if (status === 'paused') throw new HttpError(400, 'Use resume for paused downloads.');
    if (status === 'completed') throw new HttpError(400, 'Download is already completed.');
    throw new HttpError(400, 'Download cannot be started.');
  });

  app.post('/api/downloads/:dl_id/pause', {
    schema: { params: downloadIdParamSchema },
  }, async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const dlId = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(dlId);
    if (!dl) throw new HttpError(404, 'Download not found.');
    const live = aria2.getProgress(dlId);
    const effectiveStatus = live?.status ?? dl.status;
    const wasStarting = aria2.isStartingDownload(dlId);
    if (!['downloading', 'queued'].includes(effectiveStatus) && !wasStarting) {
      throw new HttpError(400, 'Download is not running.');
    }
    aria2.cancelStartingDownload(dlId);
    const pausedInAria = await aria2.pause(dlId);
    if (!pausedInAria && !wasStarting) throw new HttpError(409, 'Download is no longer tracked by aria2c.');
    db.prepare<unknown, [number]>(`UPDATE downloads SET status='paused' WHERE id=?`).run(dlId);
    return { status: 'paused' };
  });

  app.post('/api/downloads/:dl_id/resume', {
    schema: { params: downloadIdParamSchema },
  }, async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const dlId = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(dlId);
    if (!dl) throw new HttpError(404, 'Download not found.');
    const live = aria2.getProgress(dlId);
    const effectiveStatus = live?.status ?? dl.status;
    const basePath = cleanDownloadPath(settingsSnapshot().download_path ?? 'downloads');

    if (effectiveStatus === 'paused') {
      try {
        const resumed = await aria2.resume(dlId);
        if (resumed) {
          db.prepare<unknown, [number]>(`UPDATE downloads SET status='downloading' WHERE id=?`).run(dlId);
          return { status: 'resumed' };
        }
        const status = await aria2.queueDownloadStart(dl, basePath, true);
        if (status === 'queued') return { status: 'queued', restored: true };
        if (status === 'already_running') return { status: 'already_running' };
        throw new HttpError(409, 'Paused download is no longer tracked by aria2c and could not be queued.');
      } catch (err) {
        if (aria2.needsFreshStart(err instanceof Error ? err.message : String(err))) {
          await aria2.stop(dlId);
          db.prepare<unknown, [string, number]>(
            `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
          ).run('Resuming failed due to corrupted range data. Reset to pending.', dlId);
          dl.status = 'failed';
          dl.bytes_downloaded = 0;
          dl.error_message = 'Resuming failed due to corrupted range data. Reset to pending.';
          const status = await aria2.queueDownloadStart(dl, basePath, true);
          if (status === 'queued') return { status: 'queued', reset: true };
          return { status: 'reset', error: err instanceof Error ? err.message : String(err) };
        }
        throw err;
      }
    }

    if (['error', 'failed'].includes(effectiveStatus) &&
      aria2.needsFreshStart(live?.error ?? dl.error_message)) {
      await aria2.stop(dlId);
      db.prepare<unknown, [string, number]>(
        `UPDATE downloads SET status='failed', bytes_downloaded=0, error_message=? WHERE id=?`,
      ).run('Reset to pending due to corrupted range data.', dlId);
      dl.status = 'failed';
      dl.bytes_downloaded = 0;
      dl.error_message = 'Reset to pending due to corrupted range data.';
      const status = await aria2.queueDownloadStart(dl, basePath, true);
      if (status === 'queued') return { status: 'queued', reset: true };
      return { status: 'reset' };
    }

    const status = await aria2.queueDownloadStart(dl, basePath, true);
    if (status === 'queued') return { status: 'queued' };
    if (status === 'already_running') return { status: 'already_running' };
    if (status === 'completed') throw new HttpError(400, 'Download is already completed.');
    throw new HttpError(400, 'Download cannot be resumed.');
  });

  app.post('/api/downloads/:dl_id/stop', {
    schema: { params: downloadIdParamSchema },
  }, async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const dlId = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(dlId);
    if (!dl) throw new HttpError(404, 'Download not found.');
    aria2.cancelStartingDownload(dlId);
    await aria2.stop(dlId);
    markDownloadPending(dlId);
    return { status: 'stopped' };
  });

  app.delete('/api/downloads/:dl_id', {
    schema: { params: downloadIdParamSchema },
  }, async (req) => {
    const { dl_id } = req.params as { dl_id: string };
    const dlId = Number.parseInt(dl_id, 10);
    const dl = queries.getDownloadById.get(dlId);
    if (!dl) throw new HttpError(404, 'Download not found.');
    aria2.cancelStartingDownload(dlId);
    await aria2.stop(dlId);
    db.prepare<unknown, [number]>(`DELETE FROM downloads WHERE id=?`).run(dlId);
    return { status: 'deleted' };
  });

  // === SCRAPE ROUTES ===
  app.post('/api/scrape/links', {
    schema: {
      body: {
        type: 'object',
        required: ['game_url', 'list_id'],
        additionalProperties: false,
        properties: {
          game_url: { type: 'string', minLength: 1, maxLength: 2048 },
          list_id: {
            anyOf: [
              { type: 'integer', minimum: 1 },
              { type: 'string', pattern: '^\\d+$' },
            ],
          },
        },
      },
    },
  }, async (req) => {
    const body = req.body as { game_url?: string; list_id?: number };
    const listId = Number(body.list_id);
    if (!queries.getListById.get(listId)) throw new HttpError(404, 'List not found.');
    const gameUrl = await cleanUrl(body.game_url ?? '', FITGIRL_HOSTS, 'FitGirl URL');

    let links: string[];
    try {
      links = await getFuckingFastLinks(gameUrl);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }

    const existing = new Set(
      db.prepare<{ source_url: string }, [number]>(
        `SELECT source_url FROM downloads WHERE list_id=?`,
      ).all(listId).map(row => row.source_url),
    );
    const insert = db.prepare<unknown, [number, string, string]>(
      `INSERT OR IGNORE INTO downloads (list_id, source_url, filename, status) VALUES (?, ?, ?, 'pending')`,
    );
    let added = 0;
    for (const link of links) {
      const url = await cleanUrl(link, FUCKINGFAST_HOSTS, 'download link');
      if (existing.has(url)) continue;
      const result = insert.run(listId, url, cleanFilename(url) ?? '');
      existing.add(url);
      if (result.changes > 0) added++;
    }
    return { found: links.length, added, links };
  });

  app.get('/api/scrape/search', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', maxLength: 200 },
          page: { type: 'string', pattern: '^\\d+$' },
          limit: { type: 'string', pattern: '^\\d+$' },
          hydrate: { type: 'string', enum: ['true', 'false'] },
        },
      },
    },
  }, async (req) => {
    const query = req.query as Record<string, string | undefined>;
    try {
      const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
      const limit = Math.max(1, Math.min(60, Number.parseInt(query.limit ?? '24', 10) || 24));
      const hydrate = query.hydrate === 'true';
      const games = await searchFitgirl(query.query ?? '', page, limit, hydrate);
      return {
        games,
        page,
        limit,
        source: (query.query ?? '').trim() ? 'search' : 'popular-year',
        hydrated: hydrate,
      };
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/scrape/details', {
    schema: {
      querystring: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 2048 },
        },
      },
    },
  }, async (req) => {
    const query = req.query as { url?: string };
    if (!query.url) throw new HttpError(400, 'url query parameter is required.');
    const gameUrl = await cleanUrl(query.url, FITGIRL_HOSTS, 'FitGirl URL');
    try {
      return await getFitgirlGameDetails(gameUrl);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });

  // === IMAGE ROUTES ===
  app.get('/api/image', {
    schema: {
      querystring: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
  }, async (req, reply) => {
    const query = req.query as { url?: string };
    const url = query.url ?? '';
    if (!(await isPublicHttpUrl(url))) throw new HttpError(400, 'Unsupported image URL.');

    let resp;
    try {
      resp = await fetch(url, {
        redirect: 'manual',
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          referer: 'https://fitgirl-repacks.site/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        },
      });
    } catch (err) {
      throw new HttpError(502, `Could not fetch image: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (resp.status >= 300 && resp.status < 400) throw new HttpError(400, 'Image redirects are not proxied.');
    if (!resp.ok) throw new HttpError(502, `Could not fetch image: HTTP ${resp.status}`);

    const mediaType = (resp.headers.get('content-type') ?? 'image/jpeg').split(';', 1)[0];
    if (!mediaType.startsWith('image/')) throw new HttpError(400, 'URL did not return an image.');
    if (!resp.body) throw new HttpError(502, 'Image response had no body.');

    const reader = resp.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        total += buf.length;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new HttpError(413, 'Image is too large.');
        }
        chunks.push(buf);
      }
    } finally {
      reader.releaseLock();
    }

    const data = Buffer.concat(chunks);
    return reply.type(mediaType).send(data);
  });

  // === SETTINGS ROUTES ===
  app.get('/api/settings', () => settingsSnapshot());

  app.put('/api/settings', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: true,
      },
    },
  }, async (req) => {
    const body = req.body as Record<string, unknown>;
    const normalised = normaliseSettings(body);
    persistSettings(normalised);

    if ('max_concurrent' in normalised) {
      await aria2.setMaxConcurrent(Number.parseInt(normalised.max_concurrent, 10));
    }
    if ('connections_per_file' in normalised) {
      aria2.setConnectionsPerFile(Number.parseInt(normalised.connections_per_file, 10));
    }
    return { status: 'updated' };
  });

  // === STATUS ROUTES ===
  app.get('/api/status', async () => aria2.globalStats());

  app.get('/ws/progress', { websocket: true }, (socket) => {
    const timer = setInterval(() => {
      try {
        socket.send(JSON.stringify({
          type: 'progress',
          data: aria2.allProgress(),
          aria2_ok: aria2.isRunning,
        }));
      } catch {
        clearInterval(timer);
      }
    }, 1000);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });
}

// Settings validation
const ALLOWED_SETTINGS = new Set([
  'download_path',
  'max_concurrent',
  'connections_per_file',
  'auto_start_new_games',
  'browse_items_per_page',
  'browse_card_height',
  'browse_open_links_new_tab',
  'library_card_height',
  'card_ratio_width',
  'card_ratio_height',
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
  browse_card_height: [120, 320],
  library_card_height: [120, 320],
  card_ratio_width: [1, 8],
  card_ratio_height: [1, 8],
  interface_scale: [85, 125],
};

const CHOICE_SETTINGS: Record<string, Set<string>> = {
  theme_density: new Set(['compact', 'comfortable', 'spacious']),
};

const BOOL_SETTINGS = new Set([
  'auto_start_new_games',
  'browse_open_links_new_tab',
  'library_default_detail',
  'library_show_file_urls',
  'confirm_delete',
  'reduce_motion',
]);

function normaliseBool(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return 'true';
  if (['0', 'false', 'no', 'off'].includes(text)) return 'false';
  throw new Error('expected boolean');
}

function normaliseSettings(input: Record<string, unknown>): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Settings payload must be an object.');
  }

  const unknown = Object.keys(input).filter(key => !ALLOWED_SETTINGS.has(key)).sort();
  if (unknown.length) {
    throw new HttpError(400, `Unsupported setting(s): ${unknown.join(', ')}`);
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key in INT_RANGES) {
      const text = String(value ?? '').trim();
      if (!/^-?\d+$/.test(text)) {
        throw new HttpError(400, `${key} must be an integer.`);
      }
      const n = Number.parseInt(text, 10);
      const [min, max] = INT_RANGES[key];
      if (n < min || n > max) {
        throw new HttpError(400, `${key} must be between ${min} and ${max}.`);
      }
      result[key] = String(n);
    } else if (BOOL_SETTINGS.has(key)) {
      try {
        result[key] = normaliseBool(value);
      } catch {
        throw new HttpError(400, `${key} must be a boolean.`);
      }
    } else if (key in CHOICE_SETTINGS) {
      const text = String(value ?? '').trim();
      if (!CHOICE_SETTINGS[key].has(text)) {
        throw new HttpError(400, `${key} must be one of: ${[...CHOICE_SETTINGS[key]].sort().join(', ')}.`);
      }
      result[key] = text;
    } else if (key === 'download_path') {
      result[key] = cleanDownloadPath(String(value ?? ''));
    } else {
      result[key] = String(value ?? '').trim();
    }
  }
  return result;
}
