import type { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import { MAX_IMAGE_BYTES } from '../config.js';
import { HttpError, isPublicImageUrl } from '../security.js';

export function registerImageRoutes(app: FastifyInstance): void {
  app.get('/api/image', async (req, reply) => {
    const query = req.query as { url?: string };
    const url = query.url ?? '';
    if (!(await isPublicImageUrl(url))) throw new HttpError(400, 'Unsupported image URL.');

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

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of resp.body as AsyncIterable<Buffer | Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image is too large.');
      chunks.push(buf);
    }

    return reply
      .type(mediaType)
      .header('Cache-Control', 'public, max-age=86400')
      .send(Buffer.concat(chunks));
  });
}
