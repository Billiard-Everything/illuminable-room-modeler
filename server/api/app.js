// The thin HTTP layer between the browser app and GraphRepository (Phase
// 5's own "GraphRepository.graphExists / download / upload" pipeline, now
// joined by Phase 6's shared-library browse/search/sort/filter routes). A
// browser tab cannot open a raw Postgres connection — this is the piece
// that makes "the browser asks PostgreSQL" actually possible: the browser
// calls these routes (see src/anglePlot/remoteGraphRepository.js for the
// download/upload pipeline's own client — Phase 6 is backend-only, so
// nothing in src/** calls the new browse/search routes yet), this file
// calls GraphRepository, and GraphRepository is the only thing that ever
// touches SQL. Nothing here builds a query itself — see queryParsing.js
// for the (non-SQL) query-string parsing that keeps these handlers thin.
//
// Deliberately plain Node `http`, no framework: a handful of routes don't
// need one, and it keeps this server free of a dependency this project
// otherwise has no use for.
//
// Route table (order matters — see the handler below)
// -------------------------------------------------------
//   GET  /api/graphs             listGraphs      (browse/filter/sort, metadata only)
//   GET  /api/graphs/search      searchGraphs    (hash/code/angle/length search, metadata only)
//   GET  /api/graphs/recent      listRecentGraphs (metadata only)
//   GET  /api/graphs/:hash       getGraphWithGeometry (download — the one route that returns geometry)
//   POST /api/graphs             uploadExactGraphIfMissing
// The three metadata-only routes are matched before the generic
// `/api/graphs/:hash` fallback specifically so a hash can never collide
// with a literal path segment like "search" or "recent" (a real hash is a
// long, structured string that URL-encodes distinctly from either).
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
import { parseListOptions, parseSearchQuery } from './queryParsing.js';

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
    // Metadata-only browse/search routes — checked before the generic
    // /api/graphs/:hash fallback below (see this file's own route-table
    // comment on why order matters here).
    if (req.method === 'GET' && url.pathname === '/api/graphs') {
      const graphs = await repository.listGraphs(parseListOptions(url.searchParams));
      return sendJson(res, 200, { graphs });
    }

    if (req.method === 'GET' && url.pathname === '/api/graphs/search') {
      const query = parseSearchQuery(url.searchParams);
      const graphs = await repository.searchGraphs(query, parseListOptions(url.searchParams));
      return sendJson(res, 200, { graphs });
    }

    if (req.method === 'GET' && url.pathname === '/api/graphs/recent') {
      const graphs = await repository.listRecentGraphs(parseListOptions(url.searchParams));
      return sendJson(res, 200, { graphs });
    }

    // Download: the one route that returns full geometry, for exactly one
    // graph at a time — never while browsing (see this task's own
    // "avoid unnecessary database calls" / "never download geometry while
    // browsing").
    if (req.method === 'GET' && url.pathname.startsWith('/api/graphs/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/graphs/'.length));
      if (!hash) return sendJson(res, 400, { error: 'missing hash' });
      const found = await repository.getGraphWithGeometry(hash);
      if (found) {
        // Usage tracking is a side effect of a successful *download*,
        // never of browsing/searching — fire-and-forget (not awaited) so
        // a slow or failed counter update can never delay or break the
        // download response itself.
        repository.recordGraphAccess(hash).catch((err) => console.error('[graph-api] recordGraphAccess failed:', err));
      }
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
