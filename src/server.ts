import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { FRONTEND_DIR } from './config.js';
import { aria2 } from './aria2-service.js';
import { registerApiRoutes } from './api.js';
import { HttpError } from './security.js';
import { loadSettingsCache, settingsSnapshot } from './settings.js';
import { closeScraperBrowser } from './scraper.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: 'warn' } });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ detail: err.message });
    }
    const fastifyError = err as { statusCode?: number; message?: string };
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({ detail: fastifyError.message ?? 'Request failed' });
    }
    console.error(err);
    return reply.status(500).send({ detail: 'Internal server error' });
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: FRONTEND_DIR,
    prefix: '/',
    serve: false,
  });

  // Register page routes
  app.get('/', (_, reply) => sendFrontend(app, ['library.html'], reply));
  app.get('/library', (_, reply) => sendFrontend(app, ['library.html'], reply));
  app.get('/browse', (_, reply) => sendFrontend(app, ['browse.html'], reply));
  app.get('/settings', (_, reply) => sendFrontend(app, ['settings.html'], reply));

  app.get('/css/*', (req, reply) => {
    const params = req.params as { '*': string };
    const filePath = params['*'] ?? '';
    if (!filePath.endsWith('.css')) throw new HttpError(404, 'File not found');
    return sendFrontend(app, ['css', filePath], reply, 3600);
  });

  app.get('/js/*', (req, reply) => {
    const params = req.params as { '*': string };
    const filePath = params['*'] ?? '';
    if (!filePath.endsWith('.js')) throw new HttpError(404, 'File not found');
    return sendFrontend(app, ['js', filePath], reply, 3600);
  });

  app.get('/favicon.svg', (_, reply) => sendFrontend(app, ['favicon.svg'], reply, 86400));

  // Register all API routes
  registerApiRoutes(app);

  return app;
}

function sendFrontend(app: any, parts: string[], reply: any, cacheSeconds = 0) {
  const root = path.resolve(FRONTEND_DIR);
  const full = path.resolve(path.join(root, ...parts));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(404, 'File not found');
  }

  try {
    const stat = fs.statSync(full);
    const ext = path.extname(full);
    const content = fs.readFileSync(full, 'utf-8');
    const MEDIA_TYPES: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.svg': 'image/svg+xml',
    };
    return reply
      .type(MEDIA_TYPES[ext] ?? 'application/octet-stream')
      .header('Cache-Control', cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-cache')
      .header('ETag', `W/"${Math.floor(stat.mtimeMs / 1000)}-${stat.size}"`)
      .send(content);
  } catch {
    throw new HttpError(404, 'File not found');
  }
}

export async function startServer(host: string, port: number): Promise<void> {
  loadSettingsCache();
  const snapshot = settingsSnapshot();

  const maxConcurrent = Number.parseInt(snapshot.max_concurrent ?? '3', 10);
  const connectionsPerFile = Number.parseInt(snapshot.connections_per_file ?? '4', 10);

  try {
    await aria2.start(maxConcurrent, connectionsPerFile);
    await aria2.restoreTrackedDownloads();
    console.log('aria2c connected and ready.');
  } catch (err) {
    console.warn('aria2c unavailable:', err instanceof Error ? err.message : err);
    aria2.markInFlightUnavailable('aria2c is unavailable after server start.');
  }

  const app = await buildApp();
  await app.listen({ host, port });
  console.log(`EasyDL running at http://${host}:${port}`);

  const shutdown = async () => {
    await closeScraperBrowser();
    await aria2.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
