// The thin HTTP layer between the browser app and GraphRepository (Phase
// 5's own "GraphRepository.graphExists / download / upload" pipeline). A
// browser tab cannot open a raw Postgres connection — this is the piece
// that makes "the browser asks PostgreSQL" actually possible: the browser
// calls these two routes (see src/anglePlot/remoteGraphRepository.js),
// this file calls GraphRepository, and GraphRepository is the only thing
// that ever touches SQL. Nothing here builds a query itself.
//
// Deliberately plain Node `http`, no framework: two routes don't need one,
// and it keeps this server free of a dependency this project otherwise has
// no use for.
//
// Failure handling
// -----------------
// Every route is wrapped so a GraphRepository/Postgres failure never
// crashes this process or hangs the response — it logs server-side and
// replies 503, which the browser client treats exactly like "couldn't
// reach it," never a hard error (see this task's own "PostgreSQL
// unavailable must not break plotting" requirement, enforced end-to-end:
// this layer degrades gracefully, and so does the client that calls it).

import { getGraphRepository } from '../repositories/graphRepository.js';

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (!raw) return resolve({});
    try {
      resolve(JSON.parse(raw));
    } catch (err) {
      reject(err);
    }
  });
  req.on('error', reject);
});

const withCors = (res) => {
  // Wide open: this is dev/architecture scaffolding with no auth in front
  // of it yet (see the `users` table's own migration comment) — tightening
  // this to a real allowed-origin list is a deployment concern for
  // whenever this actually goes live, not part of this phase's scope.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Builds the request listener `http.createServer` needs, bound to
 * `repository` (a GraphRepository instance — see createGraphRepository).
 * Taking the repository as a parameter, rather than reaching for the
 * shared singleton itself, is what lets tests exercise real HTTP
 * round-trips against a fake repository with no real database at all (see
 * api-app.test.mjs).
 */
export const createApp = (repository) => async (req, res) => {
  withCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname.startsWith('/api/graphs/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/graphs/'.length));
      if (!hash) return sendJson(res, 400, { error: 'missing hash' });
      const found = await repository.getGraphWithGeometry(hash);
      return sendJson(res, 200, found ? { exists: true, ...found } : { exists: false });
    }

    if (req.method === 'POST' && url.pathname === '/api/graphs') {
      const body = await readJsonBody(req);
      if (!body.params || !Array.isArray(body.points)) {
        return sendJson(res, 400, { error: 'params and points are required' });
      }
      const result = await repository.uploadExactGraphIfMissing(body);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[graph-api] request failed:', err);
    sendJson(res, 503, { error: 'database unavailable' });
  }
};

// Convenience for the CLI entry point and tests that don't want to build
// their own repository: the app bound to the real shared pool.
export const createDefaultApp = async () => createApp(await getGraphRepository());
