import type { FastifyInstance } from 'fastify';
import { db, queries } from '../db/database.js';
import { cleanFilename, getFitgirlGameDetails, getFuckingFastLinks, searchFitgirl } from '../scraper.js';
import { cleanUrl, HttpError } from '../security.js';
import { FITGIRL_HOSTS, FUCKINGFAST_HOSTS } from '../config.js';

export function registerScrapeRoutes(app: FastifyInstance): void {
  app.post('/api/scrape/links', async (req) => {
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

  app.get('/api/scrape/search', async (req) => {
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

  app.get('/api/scrape/details', async (req) => {
    const query = req.query as { url?: string };
    if (!query.url) throw new HttpError(400, 'url query parameter is required.');
    const gameUrl = await cleanUrl(query.url, FITGIRL_HOSTS, 'FitGirl URL');
    try {
      return await getFitgirlGameDetails(gameUrl);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  });
}
