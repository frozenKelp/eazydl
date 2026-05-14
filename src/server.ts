import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { FRONTEND_DIR } from './config.js';
import { initDb } from './db/database.js';
import { dm } from './downloader.js';
import { registerDownloadRoutes } from './routes/downloads.js';
import { registerImageRoutes } from './routes/images.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerScrapeRoutes } from './routes/scrape.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStatusRoutes } from './routes/status.js';
import { HttpError } from './security.js';
import { loadSettingsCache, settingsSnapshot } from './settings.js';

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

  registerPageRoutes(app);
  registerImageRoutes(app);
  registerLibraryRoutes(app);
  registerDownloadRoutes(app);
  registerSettingsRoutes(app);
  registerScrapeRoutes(app);
  registerStatusRoutes(app);

  return app;
}

export async function startServer(host: string, port: number): Promise<void> {
  initDb();
  loadSettingsCache();
  const snapshot = settingsSnapshot();

  const maxConcurrent = Number.parseInt(snapshot.max_concurrent ?? '3', 10);
  const connectionsPerFile = Number.parseInt(snapshot.connections_per_file ?? '4', 10);

  try {
    await dm.start(maxConcurrent, connectionsPerFile);
    console.log('aria2c connected and ready.');
  } catch (err) {
    console.warn('aria2c unavailable:', err instanceof Error ? err.message : err);
  }

  const app = await buildApp();
  await app.listen({ host, port });
  console.log(`EasyDL running at http://${host}:${port}`);

  const shutdown = async () => {
    await dm.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
