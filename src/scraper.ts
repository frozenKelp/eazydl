import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import fetch from 'node-fetch';
import type { AnyNode, Element } from 'domhandler';
import { FUCKINGFAST_HOSTS, FITGIRL_HOSTS } from './config.js';

const HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.5',
  referer: 'https://fitgirl-repacks.site/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const POPULAR_REPACKS_URL = 'https://fitgirl-repacks.site/popular-repacks-of-the-year/';
const CACHE_TTL_MS = 5 * 60 * 1000;

const ARCHIVE_RE = /(?<name>[A-Za-z0-9][A-Za-z0-9 ._+()[\]{}'!,&@#$%^=-]{2,240}\.(?:part\d+\.rar|rar|r\d{2}|zip|7z|iso|bin))/i;
const ARCHIVE_RE_GLOBAL = /(?<name>[A-Za-z0-9][A-Za-z0-9 ._+()[\]{}'!,&@#$%^=-]{2,240}\.(?:part\d+\.rar|rar|r\d{2}|zip|7z|iso|bin))/gi;
const SIZE_VALUE_RE = /(?:from\s+)?(?:\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)?\s*(?:\/|-|\u2013|\u2014|to)\s*)?\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)/i;

const GAME_CATEGORIES = new Set(['lossless repack', 'hypervisor bypass', 'switch emulated']);
const SKIP_CATEGORIES = new Set(['uncategorized', 'updates digest']);
const STOP_EXCERPT_MARKERS = [
  'download mirrors',
  'download mirror',
  'filehoster:',
  'backwards compatibility',
  'problems during installation',
  'selective download',
];
const STOPWORDS = new Set(['a', 'an', 'and', 'for', 'of', 'the', 'to', 'with', 'in', 'on', 'pc', 'game']);

export interface ResolvedDownload {
  url: string;
  filename: string | null;
}

export interface GameResult {
  title: string;
  url: string;
  image: string | null;
  excerpt: string;
  size: string | null;
  categories: string[];
}

interface InternalGameResult extends GameResult {
  is_game?: boolean;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const searchCache = new Map<string, CacheEntry<GameResult[]>>();
const detailCache = new Map<string, CacheEntry<Partial<GameResult>>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return null;
  }
  return structuredClone(entry.value);
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  map.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: structuredClone(value) });
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function cleanFilename(value: string | null | undefined): string | null {
  if (!value) return null;
  let text = safeDecodeURIComponent(String(value)).replace(/\x00/g, ' ').trim();
  text = text.replace(/\s+/g, ' ');
  text = text.split('?', 1)[0].split('#', 1)[0];
  text = text.replace(/\/$/, '').split('/').pop()!.split('\\').pop()!;
  text = text.replace(/^[\s\t\r\n'"\u201c\u201d\u2018\u2019<>|:]+|[\s\t\r\n'"\u201c\u201d\u2018\u2019<>|:]+$/g, '');

  const match = ARCHIVE_RE.exec(text);
  if (!match?.groups?.name) {
    const fallback = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .'"']+|[ .'"']+$/g, '');
    if (
      fallback.length >= 3 &&
      fallback.length <= 240 &&
      fallback.includes('.') &&
      !fallback.startsWith('.')
    ) {
      return fallback.slice(0, 240);
    }
    return null;
  }

  let name = match.groups.name.replace(/^[ .'"']+|[ .'"']+$/g, '');
  name = name.replace(/^(?:download|file|filename|name)\s*[:\u2014\u2013-]?\s+/i, '');
  return name.slice(0, 240) || null;
}

function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const encoded = /filename\*=([^']*)''([^;]+)/i.exec(header);
  if (encoded) return cleanFilename(encoded[2]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain) return cleanFilename(plain[1]);
  return null;
}

function bestFilenameFromText(text: string): string | null {
  const names: string[] = [];
  const decoded = safeDecodeURIComponent(text || '');
  for (const match of decoded.matchAll(ARCHIVE_RE_GLOBAL)) {
    const name = cleanFilename(match.groups?.name);
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return null;
  names.sort((a, b) => {
    const aKey = [
      a.toLowerCase().includes('fitgirl-repacks.site') ? 0 : 1,
      a.toLowerCase().includes('.part') ? 0 : 1,
      a.length,
    ];
    const bKey = [
      b.toLowerCase().includes('fitgirl-repacks.site') ? 0 : 1,
      b.toLowerCase().includes('.part') ? 0 : 1,
      b.length,
    ];
    return aKey[0] - bKey[0] || aKey[1] - bKey[1] || aKey[2] - bKey[2];
  });
  return names[0];
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function getFuckingFastDownloads(
  gameUrl: string,
): Promise<Array<{ url: string; filename: string | null }>> {
  const html = await fetchHtml(gameUrl);
  const $ = cheerio.load(html);
  const results: Array<{ url: string; filename: string | null }> = [];
  const seen = new Set<string>();

  const containers = $('.dlinks').length ? $('.dlinks') : $('body');
  containers.find('a[href]').each((_, el) => {
    let href: string;
    try {
      href = new URL($(el).attr('href')!, gameUrl).href;
    } catch {
      return;
    }
    const host = new URL(href).hostname.toLowerCase();
    if (!FUCKINGFAST_HOSTS.has(host) || seen.has(href)) return;
    seen.add(href);

    let filename = cleanFilename($(el).text().trim());
    if (!filename) {
      const parent = $(el).closest('tr, li, p, div');
      filename = cleanFilename(parent.text().trim());
    }
    results.push({ url: href, filename });
  });

  if (!results.length) {
    throw new Error(
      "No fuckingfast.co links found on that page. Make sure it's a valid FitGirl game URL.",
    );
  }
  return results;
}

export async function getFuckingFastLinks(gameUrl: string): Promise<string[]> {
  return (await getFuckingFastDownloads(gameUrl)).map(item => item.url);
}

export async function resolveFuckingFastDownloadInfo(ffUrl: string): Promise<ResolvedDownload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(ffUrl, { headers: HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${ffUrl}`);
    const html = await resp.text();
    const $ = cheerio.load(html);
    const filename = filenameFromContentDisposition(resp.headers.get('content-disposition')) ??
      filenameFromFfPage($, html);

    for (const script of $('script').toArray()) {
      const text = $(script).html() ?? '';
      const match = /window\.open\(['"]+(https?:\/\/[^'")\s]+)/.exec(text);
      if (match) return { url: match[1], filename };
    }

    for (const el of $('a[href]').toArray()) {
      const href = new URL($(el).attr('href')!, ffUrl).href;
      const anchorName = cleanFilename($(el).attr('download')) ?? cleanFilename($(el).text().trim());
      const lower = href.toLowerCase().split('?', 1)[0];
      if (['.zip', '.rar', '.iso', '.7z'].some(ext => lower.endsWith(ext)) ||
        /\.(part\d+\.rar|r\d{2})(?:[?#].*)?$/i.test(href)) {
        return { url: href, filename: filename ?? anchorName ?? cleanFilename(href) };
      }
    }

    throw new Error(
      `Could not resolve a direct download URL from: ${ffUrl}\nThe page structure may have changed.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveFuckingFastDownload(ffUrl: string): Promise<string> {
  return (await resolveFuckingFastDownloadInfo(ffUrl)).url;
}

function filenameFromFfPage($: CheerioAPI, html: string): string | null {
  const selectors = [
    '[download]',
    '.filename',
    '.file-name',
    '.file_name',
    '#filename',
    '#file-name',
    'h1',
    'h2',
    'title',
  ];
  for (const selector of selectors) {
    for (const el of $(selector).toArray()) {
      const node = $(el);
      for (const value of [node.attr('download'), node.attr('title'), node.text()]) {
        const name = cleanFilename(value ?? null);
        if (name) return name;
      }
    }
  }
  return bestFilenameFromText($('body').text()) ?? bestFilenameFromText(html);
}

function getArticleCategories($: CheerioAPI, article: AnyNode): string[] {
  return $(article)
    .find('.cat-links a, a[rel="category tag"]')
    .toArray()
    .map(el => $(el).text().trim())
    .filter(Boolean);
}

function isGameArticle($: CheerioAPI, article: AnyNode): boolean {
  const cats = new Set(getArticleCategories($, article).map(cat => cat.toLowerCase()));
  if ([...cats].some(cat => SKIP_CATEGORIES.has(cat))) return false;
  return [...cats].some(cat => GAME_CATEGORIES.has(cat));
}

function queryTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const raw = match[0];
    if (STOPWORDS.has(raw) || raw.length < 2) continue;
    tokens.push(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return tokens;
}

function matchesQuery(title: string, query: string): boolean {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const normalizedTitle = [...title.toLowerCase().matchAll(/[a-z0-9]+/g)]
    .map(match => {
      const token = match[0];
      return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
    })
    .join(' ');
  const titleWords = new Set(normalizedTitle.split(' '));
  return tokens.every(token => titleWords.has(token) || normalizedTitle.includes(token));
}

function cleanExcerpt(text: string): string {
  let out = (text || ' ').replace(/\s+/g, ' ').trim();
  const lower = out.toLowerCase();
  let cutAt = out.length;
  for (const marker of STOP_EXCERPT_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) cutAt = Math.min(cutAt, idx);
  }
  out = out.slice(0, cutAt).replace(/^[\s\-\u2013\u2014|]+|[\s\-\u2013\u2014|\n\t]+$/g, '');
  out = out.replace(/#\d+\s*/g, '');
  return out.slice(0, 260).replace(/[\s,;:\-\u2013\u2014]+$/g, '');
}

function cleanSize(value: string): string | null {
  const out = (value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[ .,:;|-]+|[ .,:;|-]+$/g, '')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/^from\s+/i, '');
  return out.slice(0, 80) || null;
}

function sizeFromText(text: string): string | null {
  const normalized = (text || '').replace(/[ \t]+/g, ' ');
  for (const label of ['repack size', 'download size']) {
    const labelMatch = new RegExp(`${label}\\s*:?\\s*([^\\n\\r]{0,180})`, 'i').exec(normalized);
    const sizeMatch = labelMatch ? SIZE_VALUE_RE.exec(labelMatch[1]) : null;
    if (sizeMatch) return cleanSize(sizeMatch[0]);
  }
  return null;
}

function imageFromImg($: CheerioAPI, img: Element | undefined, baseUrl: string): string | null {
  if (!img) return null;
  const node = $(img);
  for (const attr of ['data-src', 'data-lazy-src', 'data-original', 'data-orig-file', 'src']) {
    const value = node.attr(attr);
    if (value && !value.startsWith('data:')) return new URL(value, baseUrl).href;
  }
  for (const attr of ['data-srcset', 'data-lazy-srcset', 'srcset']) {
    const srcset = node.attr(attr);
    if (!srcset) continue;
    const candidates = srcset
      .split(',')
      .map(part => part.trim().split(' ', 1)[0])
      .filter(candidate => candidate && !candidate.startsWith('data:'));
    if (candidates.length) return new URL(candidates[candidates.length - 1], baseUrl).href;
  }
  return null;
}

function imageFromArticle($: CheerioAPI, article: AnyNode, baseUrl: string): string | null {
  const img = $(article).find('img.wp-post-image, img[class*="attachment-"]').first()[0] as Element | undefined ??
    $(article).find('.entry-content img, .post-thumbnail img, figure img').first()[0] as Element | undefined ??
    $(article).find('img').first()[0] as Element | undefined;
  return imageFromImg($, img, baseUrl);
}

function excerptFromArticle($: CheerioAPI, article: AnyNode): string {
  const content = $(article).find('.entry-content').first();
  if (!content.length) return '';
  for (const node of content.children('p, div').toArray()) {
    const text = cleanExcerpt($(node).text().trim());
    if (text.length > 30) return text;
  }
  return cleanExcerpt(content.text().trim());
}

function sizeFromArticle($: CheerioAPI, article: AnyNode): string | null {
  const content = $(article).find('.entry-content').first();
  return sizeFromText((content.length ? content : $(article)).text());
}

async function enrichGame(game: InternalGameResult): Promise<InternalGameResult> {
  if (game.image && game.excerpt && game.size) return game;
  const html = await fetchHtml(game.url);
  const $ = cheerio.load(html);
  const article = $('article').first()[0] ?? $('body')[0];
  if (!isGameArticle($, article)) {
    return { ...game, is_game: false };
  }
  return {
    ...game,
    image: game.image ?? imageFromArticle($, article, game.url),
    excerpt: game.excerpt || excerptFromArticle($, article),
    size: game.size ?? sizeFromArticle($, article),
    categories: getArticleCategories($, article),
    is_game: true,
  };
}

async function enrichGames(games: InternalGameResult[]): Promise<GameResult[]> {
  const results = await Promise.allSettled(games.map(game => enrichGame({ ...game })));
  return results
    .map((result, idx) => result.status === 'fulfilled' ? result.value : games[idx])
    .filter(game => game.is_game !== false)
    .map(publicGame);
}

function publicGame(game: InternalGameResult): GameResult {
  return {
    title: game.title,
    url: game.url,
    image: game.image,
    excerpt: game.excerpt,
    size: game.size,
    categories: game.categories,
  };
}

export async function getFitgirlGameDetails(gameUrl: string): Promise<Partial<GameResult>> {
  const cached = cacheGet(detailCache, gameUrl);
  if (cached) return cached;

  const base: InternalGameResult = {
    title: '',
    url: gameUrl,
    image: null,
    excerpt: '',
    size: null,
    categories: [],
    is_game: true,
  };
  const details = await enrichGame(base);
  const result: Partial<GameResult> = publicGame(details);
  cacheSet(detailCache, gameUrl, result);
  return result;
}

function cleanPopularTitle(value: string): string {
  return (value || '').replace(/\s+/g, ' ').trim().replace(/^image:\s*/i, '').trim();
}

function popularGamesFromPage($: CheerioAPI, baseUrl: string): InternalGameResult[] {
  const content = $('.entry-content').first()[0] ?? $('article').first()[0] ?? $('body')[0];
  const seen = new Set<string>();
  const games: InternalGameResult[] = [];

  $(content).find('a[href]').each((_, el) => {
    let href: string;
    try {
      href = new URL($(el).attr('href')!, baseUrl).href;
    } catch {
      return;
    }
    const host = new URL(href).hostname.toLowerCase();
    if (!FITGIRL_HOSTS.has(host) || href.replace(/\/$/, '') === POPULAR_REPACKS_URL.replace(/\/$/, '') || seen.has(href)) {
      return;
    }

    const img = $(el).find('img').first()[0] as Element | undefined;
    const title = cleanPopularTitle(
      (img ? $(img).attr('alt') : '') ||
      (img ? $(img).attr('title') : '') ||
      $(el).attr('title') ||
      $(el).text(),
    );
    if (!title || title.length < 2) return;
    seen.add(href);
    games.push({
      title,
      url: href,
      image: imageFromImg($, img, href),
      excerpt: '',
      size: null,
      categories: [],
      is_game: true,
    });
  });

  return games;
}

export async function searchFitgirl(
  query = '',
  page = 1,
  limit = 24,
  hydrate = false,
): Promise<GameResult[]> {
  query = query.trim();
  page = Math.max(1, Number(page) || 1);
  limit = Math.max(1, Math.min(Number(limit) || 24, 60));

  const cacheKey = `${query.toLowerCase()}|${page}|${limit}|${hydrate}`;
  const cached = cacheGet(searchCache, cacheKey);
  if (cached) return cached;

  const url = query
    ? page > 1
      ? `https://fitgirl-repacks.site/page/${page}/?s=${encodeURIComponent(query)}`
      : `https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`
    : POPULAR_REPACKS_URL;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  let games: InternalGameResult[] = [];

  if (!query) {
    const popular = popularGamesFromPage($, url);
    games = popular.slice((page - 1) * limit, page * limit);
  } else {
    for (const article of $('article').slice(0, Math.max(32, limit * 2)).toArray()) {
      if (!isGameArticle($, article)) continue;
      const titleTag = $(article).find('h1.entry-title, h2.entry-title').first();
      const linkTag = titleTag.find('a').first();
      if (!linkTag.length) continue;

      const title = linkTag.text().trim();
      if (!matchesQuery(title, query)) continue;
      const gameUrl = new URL(linkTag.attr('href')!, url).href;
      games.push({
        title,
        url: gameUrl,
        image: imageFromArticle($, article, gameUrl),
        excerpt: excerptFromArticle($, article),
        size: sizeFromArticle($, article),
        categories: getArticleCategories($, article),
        is_game: true,
      });
      if (games.length >= limit) break;
    }
  }

  const publicGames = hydrate ? await enrichGames(games) : games.map(publicGame);
  cacheSet(searchCache, cacheKey, publicGames);
  return publicGames;
}
