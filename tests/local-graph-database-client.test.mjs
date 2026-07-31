import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLocalExactGraph, saveLocalExactGraph } from '../src/anglePlot/localGraphDatabaseClient.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('fetchLocalExactGraph returns points+durationMs when the local GraphDatabase has the graph', async () => {
  globalThis.fetch = async (url) => {
    assert.match(url, /\/api\/local-graphs\/hash-abc$/);
    return {
      ok: true,
      json: async () => ({ exists: true, graph: { points: [{ a: 1, b: 2 }], metadata: { computeTimeMs: 42 } } }),
    };
  };
  const result = await fetchLocalExactGraph('hash-abc');
  assert.deepEqual(result, { points: [{ a: 1, b: 2 }], durationMs: 42 });
});

test('fetchLocalExactGraph returns null when the server says exists:false', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: false }) });
  assert.equal(await fetchLocalExactGraph('hash-abc'), null);
});

test('fetchLocalExactGraph returns null (not throws) on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await fetchLocalExactGraph('hash-abc'), null);
});

test('fetchLocalExactGraph returns null (not throws) when fetch itself rejects (e.g. connection refused)', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await fetchLocalExactGraph('hash-abc'), null);
});

test('fetchLocalExactGraph returns null if the server never responds within the timeout', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const result = await fetchLocalExactGraph('hash-abc', { timeoutMs: 30 });
  assert.equal(result, null);
});

test('fetchLocalExactGraph URL-encodes the hash', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ exists: false }) }; };
  await fetchLocalExactGraph('alg1|code(a b)');
  assert.ok(capturedUrl.endsWith(encodeURIComponent('alg1|code(a b)')));
});

test('fetchLocalExactGraph defaults durationMs to null when metadata has no computeTimeMs', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ exists: true, graph: { points: [], metadata: {} } }),
  });
  const result = await fetchLocalExactGraph('hash-abc');
  assert.equal(result.durationMs, null);
});

test('saveLocalExactGraph posts params/points/computeTimeMs as JSON', async () => {
  let capturedUrl;
  let capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => ({ saved: true }) };
  };
  const params = { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 };
  await saveLocalExactGraph(params, 1, [{ a: 1, b: 2 }], 500);
  assert.match(capturedUrl, /\/api\/local-graphs$/);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capturedOptions.body), { params, points: [{ a: 1, b: 2 }], computeTimeMs: 500 });
});

test('saveLocalExactGraph includes title/graphColorHex/notes/tags/favorite/visibility when provided', async () => {
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, json: async () => ({ saved: true }) }; };
  const params = { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 };
  await saveLocalExactGraph(params, 1, [{ a: 1, b: 2 }], 500, {
    title: 'My Graph', graphColorHex: '#0284c7', notes: 'some notes', tags: ['a', 'b'], favorite: true, visibility: 'public',
  });
  const body = JSON.parse(capturedOptions.body);
  assert.equal(body.title, 'My Graph');
  assert.equal(body.graphColorHex, '#0284c7');
  assert.equal(body.notes, 'some notes');
  assert.deepEqual(body.tags, ['a', 'b']);
  assert.equal(body.favorite, true);
  assert.equal(body.visibility, 'public');
});

test('saveLocalExactGraph omits title/graphColorHex/notes/tags/favorite/visibility entirely when not provided (not even as null)', async () => {
  let capturedOptions;
  globalThis.fetch = async (url, options) => { capturedOptions = options; return { ok: true, json: async () => ({ saved: true }) }; };
  await saveLocalExactGraph({}, 1, [], null);
  const body = JSON.parse(capturedOptions.body);
  for (const key of ['title', 'graphColorHex', 'notes', 'tags', 'favorite', 'visibility']) {
    assert.ok(!(key in body), `expected "${key}" to be omitted, not present as ${JSON.stringify(body[key])}`);
  }
});

test('saveLocalExactGraph never throws when fetch itself rejects', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.doesNotReject(() => saveLocalExactGraph({}, 1, [], null));
});

test('saveLocalExactGraph never throws on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.doesNotReject(() => saveLocalExactGraph({}, 1, [], null));
});

test('saveLocalExactGraph never throws when the server times out', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.doesNotReject(() => saveLocalExactGraph({}, 1, [], null, { timeoutMs: 30 }));
});
