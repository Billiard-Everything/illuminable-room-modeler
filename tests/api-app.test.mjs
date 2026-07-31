import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../server/api/app.js';

// A fake GraphRepository — real HTTP round trips (via a real ephemeral
// server below), fake data underneath, so this exercises the actual
// request/response cycle (routing, JSON parsing, CORS, error handling)
// without any real PostgreSQL connection.
const createFakeRepository = (overrides = {}) => ({
  getGraphWithGeometry: async () => null,
  uploadExactGraphIfMissing: async () => ({ uploaded: true }),
  recordGraphAccess: async () => {},
  listGraphs: async () => [],
  searchGraphs: async () => [],
  listRecentGraphs: async () => [],
  ...overrides,
});

// A fake GraphDatabase (the file-based local permanent cache) — same
// reasoning as createFakeRepository: real HTTP round trips, fake data
// underneath, no real filesystem access.
const createFakeGraphDatabase = (overrides = {}) => ({
  loadGraph: async () => null,
  saveGraph: async (input) => ({ id: 'g1', hash: 'h1', metadata: {}, points: input.points, notes: '' }),
  ...overrides,
});

const startTestServer = async (repository, options = {}) => {
  const server = http.createServer(createApp(repository, options));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://localhost:${port}` };
};

test('GET /api/graphs/:hash returns exists:false when the repository finds nothing', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository());
  const res = await fetch(`${baseUrl}/api/graphs/some-hash`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: false });
  server.close();
});

test('GET /api/graphs/:hash returns exists:true with graph+geometry when found', async () => {
  const graph = { id: 'g1', hash: 'h1' };
  const geometry = { points: [{ a: 1, b: 2 }], pointCount: 1 };
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async (hash) => { receivedHash = hash; return { graph, geometry }; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { exists: true, graph, geometry });
  assert.equal(receivedHash, 'h1');
  server.close();
});

test('GET /api/graphs/:hash URL-decodes the hash before passing it to the repository', async () => {
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async (hash) => { receivedHash = hash; return null; },
  }));
  await fetch(`${baseUrl}/api/graphs/${encodeURIComponent('alg1|code(a b)|a(1)')}`);
  assert.equal(receivedHash, 'alg1|code(a b)|a(1)');
  server.close();
});

test('POST /api/graphs uploads via the repository and returns its result verbatim', async () => {
  let receivedBody = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    uploadExactGraphIfMissing: async (body) => { receivedBody = body; return { uploaded: true, graph: { id: 'g1' } }; },
  }));
  const payload = {
    params: { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 },
    points: [{ a: 1, b: 2 }], durationMs: 100,
  };
  const res = await fetch(`${baseUrl}/api/graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { uploaded: true, graph: { id: 'g1' } });
  assert.deepEqual(receivedBody, payload);
  server.close();
});

test('POST /api/graphs rejects a request missing params or points with 400, never touching the repository', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    uploadExactGraphIfMissing: async () => { called = true; return { uploaded: true }; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
  server.close();
});

test('a repository failure (e.g. Postgres unavailable) returns 503, not a crash', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => { throw new Error('connection refused'); },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error);
  server.close();
});

test('unknown routes return 404', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository());
  const res = await fetch(`${baseUrl}/api/unknown`);
  assert.equal(res.status, 404);
  server.close();
});

test('OPTIONS preflight requests get CORS headers and a 204, without touching the repository', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => { called = true; return null; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(called, false);
  server.close();
});

// --- Shared graph library routes (Phase 6) --------------------------------

test('GET /api/graphs calls listGraphs with parsed query options and returns { graphs }', async () => {
  let receivedOptions = null;
  const graphs = [{ hash: 'h1', pointCount: 10 }];
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async (options) => { receivedOptions = options; return graphs; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs?sort=oldest&limit=5`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { graphs });
  assert.deepEqual(receivedOptions, { sort: 'oldest', limit: 5 });
  server.close();
});

test('GET /api/graphs/search calls searchGraphs with the parsed search query and list options', async () => {
  let receivedQuery = null;
  let receivedOptions = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    searchGraphs: async (query, options) => { receivedQuery = query; receivedOptions = options; return []; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/search?code=RRL&angleA=15&sort=most_downloaded`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { graphs: [] });
  assert.deepEqual(receivedQuery, { sequenceText: 'RRL', angleA: 15 });
  assert.deepEqual(receivedOptions, { sort: 'most_downloaded' });
  server.close();
});

test('GET /api/graphs/recent calls listRecentGraphs and is matched before the generic :hash route', async () => {
  let recentCalled = false;
  let hashRouteCalled = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listRecentGraphs: async () => { recentCalled = true; return []; },
    getGraphWithGeometry: async () => { hashRouteCalled = true; return null; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/recent`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { graphs: [] });
  assert.equal(recentCalled, true);
  assert.equal(hashRouteCalled, false, '"recent" must never be treated as a hash by the download route');
  server.close();
});

test('GET /api/graphs/search is matched before the generic :hash route (never treated as a hash)', async () => {
  let hashRouteCalled = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    searchGraphs: async () => [],
    getGraphWithGeometry: async () => { hashRouteCalled = true; return null; },
  }));
  await fetch(`${baseUrl}/api/graphs/search?hash=abc`);
  assert.equal(hashRouteCalled, false);
  server.close();
});

test('a successful GET /api/graphs/:hash records access via recordGraphAccess', async () => {
  let recordedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph: { hash: 'h1' }, geometry: { points: [] } }),
    recordGraphAccess: async (hash) => { recordedHash = hash; },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`);
  assert.equal(res.status, 200);
  // recordGraphAccess is fire-and-forget (not awaited by the route), so
  // give its microtask a turn to run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recordedHash, 'h1');
  server.close();
});

test('a miss on GET /api/graphs/:hash never calls recordGraphAccess', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => null,
    recordGraphAccess: async () => { called = true; },
  }));
  await fetch(`${baseUrl}/api/graphs/missing-hash`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
  server.close();
});

test('a recordGraphAccess failure never affects the download response itself', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    getGraphWithGeometry: async () => ({ graph: { hash: 'h1' }, geometry: { points: [] } }),
    recordGraphAccess: async () => { throw new Error('tracking db down'); },
  }));
  const res = await fetch(`${baseUrl}/api/graphs/h1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists, true);
  server.close();
});

test('browse/search/recent routes never return a `points` field, even if the repository fake includes one', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async () => [{ hash: 'h1', pointCount: 5, hasExactGeometry: true }],
  }));
  const res = await fetch(`${baseUrl}/api/graphs`);
  const body = await res.json();
  assert.ok(!('points' in body.graphs[0]));
  server.close();
});

// --- Local file-based GraphDatabase routes (permanent render cache) -------

test('GET /api/local-graphs/:hash returns exists:false when the local GraphDatabase finds nothing', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository(), { graphDatabase: createFakeGraphDatabase() });
  const res = await fetch(`${baseUrl}/api/local-graphs/some-hash`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: false });
  server.close();
});

test('GET /api/local-graphs/:hash returns exists:true with the graph when found', async () => {
  const graph = { id: 'g1', hash: 'h1', metadata: { computeTimeMs: 10 }, points: [{ a: 1, b: 2 }], notes: '' };
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ loadGraph: async (hash) => { receivedHash = hash; return graph; } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/h1`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { exists: true, graph });
  assert.equal(receivedHash, 'h1');
  server.close();
});

test('GET /api/local-graphs/:hash URL-decodes the hash before passing it to the GraphDatabase', async () => {
  let receivedHash = null;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ loadGraph: async (hash) => { receivedHash = hash; return null; } }),
  });
  await fetch(`${baseUrl}/api/local-graphs/${encodeURIComponent('alg1|code(a b)|a(1)')}`);
  assert.equal(receivedHash, 'alg1|code(a b)|a(1)');
  server.close();
});

test('POST /api/local-graphs saves via the GraphDatabase and returns { saved: true, graph }', async () => {
  let receivedInput = null;
  const savedGraph = { id: 'g1', hash: 'h1', metadata: {}, points: [{ a: 1, b: 2 }], notes: '' };
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ saveGraph: async (input) => { receivedInput = input; return savedGraph; } }),
  });
  const payload = {
    params: { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 },
    points: [{ a: 1, b: 2 }], computeTimeMs: 100,
  };
  const res = await fetch(`${baseUrl}/api/local-graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { saved: true, graph: savedGraph });
  assert.deepEqual(receivedInput, payload);
  server.close();
});

test('POST /api/local-graphs rejects a request missing params or points with 400, never touching the GraphDatabase', async () => {
  let called = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ saveGraph: async () => { called = true; } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(called, false);
  server.close();
});

test('a GraphDatabase failure (e.g. disk error) on /api/local-graphs returns 503, not a crash', async () => {
  const { server, baseUrl } = await startTestServer(createFakeRepository(), {
    graphDatabase: createFakeGraphDatabase({ loadGraph: async () => { throw new Error('EACCES'); } }),
  });
  const res = await fetch(`${baseUrl}/api/local-graphs/h1`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error);
  server.close();
});

test('/api/local-graphs never collides with /api/graphs (the PostgreSQL-backed routes)', async () => {
  let repoCalled = false;
  let dbCalled = false;
  const { server, baseUrl } = await startTestServer(
    createFakeRepository({ getGraphWithGeometry: async () => { repoCalled = true; return null; } }),
    { graphDatabase: createFakeGraphDatabase({ loadGraph: async () => { dbCalled = true; return null; } }) },
  );
  await fetch(`${baseUrl}/api/local-graphs/h1`);
  assert.equal(dbCalled, true);
  assert.equal(repoCalled, false);
  server.close();
});

// --- /health and CORS_ORIGIN (deployment) ---------------------------------

test('GET /health returns 200 { status: "ok" } without touching the repository', async () => {
  let repositoryTouched = false;
  const { server, baseUrl } = await startTestServer(createFakeRepository({
    listGraphs: async () => { repositoryTouched = true; return []; },
  }));
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(repositoryTouched, false);
  server.close();
});

test('with CORS_ORIGIN unset, Access-Control-Allow-Origin is a wildcard (local-dev default)', async () => {
  const original = process.env.CORS_ORIGIN;
  delete process.env.CORS_ORIGIN;
  try {
    const { server, baseUrl } = await startTestServer(createFakeRepository());
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    server.close();
  } finally {
    if (original !== undefined) process.env.CORS_ORIGIN = original;
  }
});

test('with CORS_ORIGIN set, a matching request Origin is echoed back with Vary: Origin', async () => {
  const original = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://example.github.io,https://other.example';
  try {
    const { server, baseUrl } = await startTestServer(createFakeRepository());
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://example.github.io' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.github.io');
    assert.equal(res.headers.get('vary'), 'Origin');
    server.close();
  } finally {
    if (original === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = original;
  }
});

test('with CORS_ORIGIN set, a non-matching request Origin gets no Access-Control-Allow-Origin header', async () => {
  const original = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://example.github.io';
  try {
    const { server, baseUrl } = await startTestServer(createFakeRepository());
    const res = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://not-allowed.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    server.close();
  } finally {
    if (original === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = original;
  }
});
