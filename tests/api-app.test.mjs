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
  ...overrides,
});

const startTestServer = async (repository) => {
  const server = http.createServer(createApp(repository));
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
