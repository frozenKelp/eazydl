import type { FastifyInstance } from 'fastify';
import { dm } from '../downloader.js';

export function registerStatusRoutes(app: FastifyInstance): void {
  app.get('/api/status', async () => dm.globalStats());

  app.get('/ws/progress', { websocket: true }, (socket) => {
    const timer = setInterval(() => {
      try {
        socket.send(JSON.stringify({
          type: 'progress',
          data: dm.allProgress(),
          aria2_ok: dm.isRunning,
        }));
      } catch {
        clearInterval(timer);
      }
    }, 1000);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });
}
