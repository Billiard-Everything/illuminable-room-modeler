// CLI entry point: `node server/api/start.js` (or `npm run server:api`).
// Starts the shared graph library's HTTP API (server/api/app.js) bound to
// the real PostgreSQL pool. Not started automatically by `npm run dev` —
// the browser app works fully without it (see remoteGraphRepository.js's
// own graceful-failure behavior); this is only needed to actually exercise
// the download/upload pipeline against a real database.

import http from 'node:http';
import { createDefaultApp } from './app.js';

const PORT = process.env.GRAPH_API_PORT ? Number(process.env.GRAPH_API_PORT) : 8787;

const app = await createDefaultApp();
http.createServer(app).listen(PORT, () => {
  console.log(`[graph-api] listening on http://localhost:${PORT}`);
});
