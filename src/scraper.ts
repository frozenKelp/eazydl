import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { FUCKINGFAST_HOSTS, FITGIRL_HOSTS } from './config.js';

const HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.5',
  'accept-encoding': 'gzip, deflate, br',
  'cache-control': 'max-age=0',
  referer: 'https://fitgirl-repacks.site/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not A;Brand";v="99", "Chromium";v="131", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

const POPULAR_REPACKS_URL = 'https://fitgirl-repacks.site/popular-repacks-of-the-year/';
const CACHE_TTL_MS = 5 * 60 * 1000;
const BROWSER_FETCH_TIMEOUT_MS = 14000;
const BROWSER_FETCH_TOTAL_TIMEOUT_MS = 18000;
const BROWSER_FETCH_CONCURRENCY = 2;
const DETAIL_HYDRATE_CONCURRENCY = 3;

let browser: Browser | null = null;
let browserContext: BrowserContext | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let activeBrowserFetches = 0;
const browserFetchQueue: Array<() => void> = [];

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }).then(launched => {
    browser = launched;
    launched.on('disconnected', () => {
      if (browser === launched) browser = null;
      browserContext = null;
    });
    return launched;
  }).finally(() => {
    browserLaunchPromise = null;
  });

  return browserLaunchPromise;
}

async function getBrowserContext(): Promise<BrowserContext> {
  if (browserContext) return browserContext;

  const browserInstance = await getBrowser();
  const context = await browserInstance.newContext({
    userAgent: HEADERS['user-agent'],
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'accept-language': HEADERS['accept-language'],
      referer: HEADERS.referer,
      'sec-ch-ua': HEADERS['sec-ch-ua'],
      'sec-ch-ua-mobile': HEADERS['sec-ch-ua-mobile'],
      'sec-ch-ua-platform': HEADERS['sec-ch-ua-platform'],
      'sec-fetch-dest': HEADERS['sec-fetch-dest'],
      'sec-fetch-mode': HEADERS['sec-fetch-mode'],
      'sec-fetch-site': HEADERS['sec-fetch-site'],
      'sec-fetch-user': HEADERS['sec-fetch-user'],
      'upgrade-insecure-requests': HEADERS['upgrade-insecure-requests'],
    },
  });
  context.setDefaultNavigationTimeout(BROWSER_FETCH_TIMEOUT_MS);
  context.setDefaultTimeout(7000);
  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      return route.abort().catch(() => undefined);
    }
    return route.continue().catch(() => undefined);
  });
  context.on('close', () => {
    if (browserContext === context) browserContext = null;
  });
  browserContext = context;
  return context;
}

async function acquireBrowserFetchSlot(): Promise<void> {
  if (activeBrowserFetches < BROWSER_FETCH_CONCURRENCY) {
    activeBrowserFetches++;
    return;
  }
  return new Promise(resolve => {
    browserFetchQueue.push(() => {
      activeBrowserFetches++;
      resolve();
    });
  });
}

function releaseBrowserFetchSlot(): void {
  activeBrowserFetches = Math.max(0, activeBrowserFetches - 1);
  const next = browserFetchQueue.shift();
  if (next) next();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function browserFetchHtml(url: string): Promise<string> {
  await acquireBrowserFetchSlot();
  let page: Awaited<ReturnType<BrowserContext['newPage']>> | null = null;

  try {
    const context = await getBrowserContext();
    page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_FETCH_TIMEOUT_MS });
    if (!response) {
      throw new Error(`No response loading ${url}`);
    }
    const status = response.status();
    if (status >= 400) {
      if (status === 403) {
        throw new Error(
          `HTTP 403 fetching ${url}. The FitGirl site is blocking requests with DDoS protection/anti-bot measures. ` +
          'This cannot be scraped directly from the app without a browser-capable proxy or a different source.',
        );
      }
      throw new Error(`HTTP ${status} fetching ${url}`);
    }
    await page.waitForSelector('article, .entry-content, .dlinks, body', { timeout: 5000 }).catch(() => null);
    return await page.content();
  } finally {
    await page?.close().catch(() => undefined);
    releaseBrowserFetchSlot();
  }
}

export async function closeScraperBrowser(): Promise<void> {
  await browserContext?.close().catch(() => undefined);
  browserContext = null;
  await browser?.close().catch(() => undefined);
  browser = null;
}

const ARCHIVE_RE = /(?<name>[A-Za-z0-9][A-Za-z0-9 ._+()[\]{}'!,&@#$%^=-]{2,240}\.(?:part\d+\.rar|rar|r\d{2}|zip|7z|iso|bin))/i;
const ARCHIVE_RE_GLOBAL = /(?<name>[A-Za-z0-9][A-Za-z0-9 ._+()[\]{}'!,&@#$%^=-]{2,240}\.(?:part\d+\.rar|rar|r\d{2}|zip|7z|iso|bin))/gi;
const SIZE_VALUE_RE = /(?:from\s+)?(?:\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)?\s*(?:\/|-|\u2013|\u2014|to)\s*)?\d+(?:[.,]\d+)?\s*(?:KB|MB|GB|TB)/i;

const GAME_CATEGORIES = new Set(['lossless repack', 'hypervisor bypass', 'switch emulated']);
const SKIP_CATEGORIES = new Set(['uncategorized', 'updates digest']);
const STOPWORDS = new Set(['a', 'an', 'and', 'for', 'of', 'the', 'to', 'with', 'in', 'on', 'pc', 'game']);

export interface ResolvedDownload {
  url: string;
  filename: string | null;
}

export interface GameResult {
  title: string;
  url: string;
  image: string | null;
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
  return await withTimeout(
    browserFetchHtml(url),
    BROWSER_FETCH_TOTAL_TIMEOUT_MS,
    `Timed out loading ${url}. The site may be delaying browser access with DDoS protection.`,
  );
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
      const patterns = [
        /window\.open\(\s*['"]+(https?:\/\/[^'")\s]+)/ig,
        /(?:location\.href|window\.location)\s*=\s*['"]+(https?:\/\/[^'")\s]+)/ig,
        /['"]url['"]\s*:\s*['"]+(https?:\/\/[^'")\s]+)/ig,
        /https?:\/\/[^\s'"<>\\]+/ig,
      ];
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const candidate = match[1] ?? match[0];
          if (looksLikeDownloadUrl(candidate)) return { url: candidate, filename };
        }
      }
    }

    for (const el of $('a[href]').toArray()) {
      const href = new URL($(el).attr('href')!, ffUrl).href;
      const anchorName = cleanFilename($(el).attr('download')) ?? cleanFilename($(el).text().trim());
      if (looksLikeDownloadUrl(href)) {
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

function looksLikeDownloadUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const lowerPath = parsed.pathname.toLowerCase();
  return ['.zip', '.rar', '.iso', '.7z', '.bin'].some(ext => lowerPath.endsWith(ext)) ||
    /\.(part\d+\.rar|r\d{2})(?:$|[?#])/i.test(parsed.href) ||
    /\/download(?:$|[/?#])/i.test(parsed.pathname);
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

function sizeFromArticle($: CheerioAPI, article: AnyNode): string | null {
  const content = $(article).find('.entry-content').first();
  return sizeFromText((content.length ? content : $(article)).text());
}

async function enrichGame(game: InternalGameResult): Promise<InternalGameResult> {
  if (game.image && game.size) return game;
  const html = await fetchHtml(game.url);
  const $ = cheerio.load(html);
  const article = $('article').first()[0] ?? $('body')[0];
  if (!isGameArticle($, article)) {
    return { ...game, is_game: false };
  }
  return {
    ...game,
    image: game.image ?? imageFromArticle($, article, game.url),
    size: game.size ?? sizeFromArticle($, article),
    categories: getArticleCategories($, article),
    is_game: true,
  };
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        results[idx] = { status: 'fulfilled', value: await worker(items[idx], idx) };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function enrichGames(games: InternalGameResult[]): Promise<GameResult[]> {
  const results = await mapConcurrent(games, DETAIL_HYDRATE_CONCURRENCY, game => enrichGame({ ...game }));
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
    for (const article of $('article').toArray()) {
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
