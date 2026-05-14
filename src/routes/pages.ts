import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { FRONTEND_DIR } from '../config.js';
import { HttpError } from '../security.js';

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
};

function frontendPath(...parts: string[]): string {
  const root = path.resolve(FRONTEND_DIR);
  const full = path.resolve(path.join(root, ...parts));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(404, 'File not found');
  }
  return full;
}

function sendFrontend(parts: string[], reply: FastifyReply, cacheSeconds = 0) {
  const full = frontendPath(...parts);
  try {
    const stat = fs.statSync(full);
    const ext = path.extname(full);
    const content = fs.readFileSync(full, 'utf-8');
    return reply
      .type(MEDIA_TYPES[ext] ?? 'application/octet-stream')
      .header('Cache-Control', cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-cache')
      .header('ETag', `W/"${Math.floor(stat.mtimeMs / 1000)}-${stat.size}"`)
      .send(content);
  } catch {
    throw new HttpError(404, 'File not found');
  }
}

export function registerPageRoutes(app: FastifyInstance): void {
  app.get('/', (_, reply) => sendFrontend(['library.html'], reply));
  app.get('/library', (_, reply) => sendFrontend(['library.html'], reply));
  app.get('/browse', (_, reply) => sendFrontend(['browse.html'], reply));
  app.get('/settings', (_, reply) => sendFrontend(['settings.html'], reply));

  app.get('/css/*', (req, reply) => {
    const params = req.params as { '*': string };
    const filePath = params['*'] ?? '';
    if (!filePath.endsWith('.css')) throw new HttpError(404, 'File not found');
    return sendFrontend(['css', filePath], reply, 3600);
  });

  app.get('/js/*', (req, reply) => {
    const params = req.params as { '*': string };
    const filePath = params['*'] ?? '';
    if (!filePath.endsWith('.js')) throw new HttpError(404, 'File not found');
    return sendFrontend(['js', filePath], reply, 3600);
  });

  app.get('/favicon.svg', (_, reply) => sendFrontend(['favicon.svg'], reply, 86400));
}
