import { ensureDirs } from './ensureDirs.js';
import { startServer } from './server.js';

ensureDirs();

const host = process.env.EASYDL_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.EASYDL_PORT ?? '8001', 10);

startServer(host, port).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
