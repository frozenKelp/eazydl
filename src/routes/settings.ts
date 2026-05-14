import type { FastifyInstance } from 'fastify';
import { dm } from '../downloader.js';
import { normaliseSettings, persistSettings, settingsSnapshot } from '../settings.js';

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', () => settingsSnapshot());

  app.put('/api/settings', async (req) => {
    const normalised = normaliseSettings(req.body as Record<string, unknown>);
    persistSettings(normalised);

    if ('max_concurrent' in normalised) {
      await dm.setMaxConcurrent(Number.parseInt(normalised.max_concurrent, 10));
    }
    if ('connections_per_file' in normalised) {
      dm.setConnectionsPerFile(Number.parseInt(normalised.connections_per_file, 10));
    }
    return { status: 'updated' };
  });
}
