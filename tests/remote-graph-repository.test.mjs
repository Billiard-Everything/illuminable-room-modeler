import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteExactGraph, uploadRemoteExactGraph } from '../src/anglePlot/remoteGraphRepository.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('fetchRemoteExactGraph returns points+durationMs when the server has the graph', async () => {
  globalThis.fetch = async (url) => {
    assert.match(url, /\/api\/graphs\/hash-abc$/);
    return { ok: true, json: async () => ({ exists: true, geometry: { points: [{ a: 1, b: 2 }], durationMs: 42 } }) };
  };
  const result = await fetchRemoteExactGraph('hash-abc');
  assert.deepEqual(result, { points: [{ a: 1, b: 2 }], durationMs: 42 });
});

test('fetchRemoteExactGraph returns null when the server says exists:false', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: false }) });
  assert.equal(await fetchRemoteExactGraph('hash-abc'), null);
});

test('fetchRemoteExactGraph returns null (not throws) on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await fetchRemoteExactGraph('hash-abc'), null);
});

test('fetchRemoteExactGraph returns null (not throws) when fetch itself rejects (e.g. connection refused)', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await fetchRemoteExactGraph('hash-abc'), null);
});

test('fetchRemoteExactGraph returns null if the server never responds within the timeout', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const result = await fetchRemoteExactGraph('hash-abc', { timeoutMs: 30 });
  assert.equal(result, null);
});

test('fetchRemoteExactGraph URL-encodes the hash', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ exists: false }) }; };
  await fetchRemoteExactGraph('alg1|code(a b)');
  assert.ok(capturedUrl.endsWith(encodeURIComponent('alg1|code(a b)')));
});

test('uploadRemoteExactGraph posts params/algorithmVersion/points/durationMs as JSON', async () => {
  let capturedUrl;
  let capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, json: async () => ({ uploaded: true }) };
  };
  const params = { sequenceText: 'X', angleA: 1, angleB: 2, angleStepInput: '0.1', baseLength: 90 };
  await uploadRemoteExactGraph(params, 1, [{ a: 1, b: 2 }], 500);
  assert.match(capturedUrl, /\/api\/graphs$/);
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capturedOptions.body), { params, algorithmVersion: 1, points: [{ a: 1, b: 2 }], durationMs: 500 });
});

test('uploadRemoteExactGraph never throws when fetch itself rejects', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  await assert.doesNotReject(() => uploadRemoteExactGraph({}, 1, [], null));
});

test('uploadRemoteExactGraph never throws on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.doesNotReject(() => uploadRemoteExactGraph({}, 1, [], null));
});

test('uploadRemoteExactGraph never throws when the server times out', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.doesNotReject(() => uploadRemoteExactGraph({}, 1, [], null, { timeoutMs: 30 }));
});
