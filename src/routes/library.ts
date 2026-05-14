import type { FastifyInstance } from 'fastify';
import { db, queries, type DownloadRow } from '../db/database.js';
import { cancelStartingDownload } from '../downloadService.js';
import { dm } from '../downloader.js';
import { downloadToDict, listToDict } from '../serializers.js';
import { cleanFilename, getFuckingFastDownloads } from '../scraper.js';
import { cleanUrl, HttpError } from '../security.js';
import { FITGIRL_HOSTS, FUCKINGFAST_HOSTS } from '../config.js';

export function registerLibraryRoutes(app: FastifyInstance): void {
  app.get('/api/lists', () => {
    return queries.getLists.all().map(list => listToDict(list));
  });

  app.get('/api/library', () => {
    return { lists: queries.getLists.all().map(list => listToDict(list, true)) };
  });

  app.post('/api/lists', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, (req, reply) => {
    const body = req.body as { name: string };
    const name = body.name.trim();
    if (!name) throw new HttpError(400, 'List name cannot be empty.');
    if (queries.getListByName.get(name)) throw new HttpError(400, 'A list with that name already exists.');
    const result = db.prepare<[string]>(`INSERT INTO link_lists (name) VALUES (?)`).run(name);
    return reply.status(201).send({ id: result.lastInsertRowid, name });
  });

  app.delete('/api/lists/:list_id', async (req) => {
    const { list_id } = req.params as { list_id: string };
    const id = Number.parseInt(list_id, 10);
    const list = queries.getListById.get(id);
    if (!list) throw new HttpError(404, 'List not found.');
    for (const dl of queries.getDownloadsForList.all(list.id)) {
      cancelStartingDownload(dl.id);
      await dm.stop(dl.id);
    }
    db.prepare<[number]>(`DELETE FROM link_lists WHERE id=?`).run(list.id);
    return { status: 'deleted' };
  });

  app.get('/api/lists/:list_id/downloads', (req) => {
    const { list_id } = req.params as { list_id: string };
    const id = Number.parseInt(list_id, 10);
    return queries.getDownloadsForList.all(id).map(downloadToDict);
  });

  app.post('/api/lists/:list_id/links', async (req) => {
    const { list_id } = req.params as { list_id: string };
    const body = req.body as { urls?: string[] };
    const id = Number.parseInt(list_id, 10);
    if (!queries.getListById.get(id)) throw new HttpError(404, 'List not found.');
    const urls = Array.isArray(body.urls) ? body.urls.slice(0, 200) : [];
    const existing = new Set(
      db.prepare<[number], { source_url: string }>(
        `SELECT source_url FROM downloads WHERE list_id=?`,
      ).all(id).map(row => row.source_url),
    );
    const insert = db.prepare<[number, string]>(
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
    return { added };
  });

  app.post('/api/games', async (req, reply) => {
    const body = req.body as {
      title?: string;
      game_url?: string;
      image_url?: string;
      description?: string;
      size?: string;
      categories?: string[];
    };
    const title = (body.title ?? '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Title is required.');
    const gameUrl = await cleanUrl(body.game_url ?? '', FITGIRL_HOSTS, 'FitGirl URL');

    let list = queries.getListByName.get(title);
    if (!list) {
      const result = db.prepare<[string]>(`INSERT INTO link_lists (name) VALUES (?)`).run(title);
      list = queries.getListById.get(Number(result.lastInsertRowid));
    }
    if (!list) throw new HttpError(500, 'Could not create library item.');

    const categories = (body.categories ?? []).map(cat => cat.trim()).filter(Boolean);
    const size = (body.size ?? '').replace(/^from\s+/i, '').trim().slice(0, 80);
    if (gameUrl && !list.source_url) db.prepare<[string, number]>(`UPDATE link_lists SET source_url=? WHERE id=?`).run(gameUrl, list.id);
    if (body.image_url && !list.image_url) db.prepare<[string, number]>(`UPDATE link_lists SET image_url=? WHERE id=?`).run(body.image_url.trim(), list.id);
    if (body.description && !list.description) db.prepare<[string, number]>(`UPDATE link_lists SET description=? WHERE id=?`).run(body.description.trim().slice(0, 2000), list.id);
    if (size && !list.size) db.prepare<[string, number]>(`UPDATE link_lists SET size=? WHERE id=?`).run(size, list.id);
    if (categories.length && !list.categories) db.prepare<[string, number]>(`UPDATE link_lists SET categories=? WHERE id=?`).run(categories.slice(0, 12).join('|'), list.id);

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
    const insert = db.prepare<[number, string, string]>(
      `INSERT OR IGNORE INTO downloads (list_id, source_url, filename, status) VALUES (?, ?, ?, 'pending')`,
    );
    const updateFilename = db.prepare<[string, number]>(
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
}
