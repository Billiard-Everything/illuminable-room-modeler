// CLI entry point: `node server/api/start.js` (or `npm run server:api`).
// Starts the shared graph library's HTTP API (server/api/app.js) bound to
// the real PostgreSQL pool. Not started automatically by `npm run dev` —
// the browser app works fully without it (see remoteGraphRepository.js's
// own graceful-failure behavior); this is only needed to actually exercise
// the download/upload pipeline against a real database, or to run this as
// the deployed backend (see DEPLOYMENT.md).

import 'dotenv/config';
import http from 'node:http';
import { createDefaultApp } from './app.js';
import { getPool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';

// Render (and most hosting platforms) assign the port to listen on via
// PORT and expect the app to bind to it — GRAPH_API_PORT is this project's
// own local-development override, for the rare case 8787 is already taken.
const PORT = process.env.PORT
  ? Number(process.env.PORT)
  : (process.env.GRAPH_API_PORT ? Number(process.env.GRAPH_API_PORT) : 8787);

// Applies any not-yet-applied migrations (server/db/migrations/*.sql)
// before accepting traffic, so a fresh deployment's database always has
// the current schema without a separate manual step — important on
// hosting tiers that don't offer shell access to run migrate.js by hand
// (e.g. Render's free tier). Deliberately non-fatal: a local `npm run
// server:api` with no Postgres configured at all should still start and
// serve requests (falling back to its existing per-request 503 handling —
// see app.js), not refuse to boot entirely.
try {
  const pool = await getPool();
  const applied = await runMigrations(pool);
  console.log(`[graph-api] ${applied.length > 0 ? `applied migrations: ${applied.join(', ')}` : 'schema already up to date'}`);
} catch (err) {
  // A connection refusal to "localhost" often surfaces as an AggregateError
  // (Node tries both the ::1 and 127.0.0.1 resolutions) whose own .message
  // is empty — .errors carries the actual per-attempt messages in that
  // case, so this falls back to those rather than logging a blank reason.
  const reason = err.message || err.errors?.map((e) => e.message).join('; ') || String(err);
  console.warn('[graph-api] could not run migrations at startup (continuing anyway):', reason);
}

const app = await createDefaultApp();
http.createServer(app).listen(PORT, () => {
  console.log(`[graph-api] listening on port ${PORT}`);
});
