import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchLocalExactGraph, saveLocalExactGraph, fetchLocalGraphDetails,
  fetchLocalGraphLibraryPage, updateLocalGraphMetadata, deleteLocalGraph,
} from '../src/anglePlot/localGraphDatabaseClient.js';

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

// --- fetchLocalGraphDetails (Graph Database browser: selected-card detail) ---

test('fetchLocalGraphDetails returns points+durationMs+notes when the graph exists', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ exists: true, graph: { points: [{ a: 1, b: 2 }], metadata: { computeTimeMs: 42 }, notes: 'my notes' } }),
  });
  const result = await fetchLocalGraphDetails('hash-abc');
  assert.deepEqual(result, { points: [{ a: 1, b: 2 }], durationMs: 42, notes: 'my notes' });
});

test('fetchLocalGraphDetails defaults notes to an empty string when absent', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: true, graph: { points: [], metadata: {} } }) });
  const result = await fetchLocalGraphDetails('hash-abc');
  assert.equal(result.notes, '');
});

test('fetchLocalGraphDetails returns null when the graph does not exist', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: false }) });
  assert.equal(await fetchLocalGraphDetails('hash-abc'), null);
});

test('fetchLocalGraphDetails returns null (never throws) on a non-ok response or a rejected fetch', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await fetchLocalGraphDetails('hash-abc'), null);
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal(await fetchLocalGraphDetails('hash-abc'), null);
});

// --- fetchLocalGraphLibraryPage (Graph Database browser browse/search) ---

test('fetchLocalGraphLibraryPage with no search fields hits GET /api/local-graphs (browse, not search)', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchLocalGraphLibraryPage();
  assert.match(capturedUrl, /\/api\/local-graphs\?/);
  assert.ok(!capturedUrl.includes('/api/local-graphs/search'));
});

test('fetchLocalGraphLibraryPage routes to GET /api/local-graphs/search the moment any search field is present', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchLocalGraphLibraryPage({ search: { code: 'RRL' } });
  assert.match(capturedUrl, /\/api\/local-graphs\/search\?/);
  assert.match(capturedUrl, /code=RRL/);
});

test('fetchLocalGraphLibraryPage sends search.text as the q query param, and routes to /search on its own', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchLocalGraphLibraryPage({ search: { text: 'boundary case' } });
  const url = new URL(capturedUrl);
  assert.match(capturedUrl, /\/api\/local-graphs\/search\?/);
  assert.equal(url.searchParams.get('q'), 'boundary case');
});

test('fetchLocalGraphLibraryPage passes sort/limit/offset as query params', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchLocalGraphLibraryPage({ sort: 'oldest', limit: 20, offset: 40 });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('sort'), 'oldest');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('offset'), '40');
});

test('fetchLocalGraphLibraryPage passes title/favorite/visibility/tags search fields as query params', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ graphs: [] }) }; };
  await fetchLocalGraphLibraryPage({ search: { title: 'My Graph', favorite: true, visibility: 'public', tags: ['a', 'b'] } });
  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('title'), 'My Graph');
  assert.equal(url.searchParams.get('favorite'), 'true');
  assert.equal(url.searchParams.get('visibility'), 'public');
  assert.equal(url.searchParams.get('tags'), 'a,b');
});

test('fetchLocalGraphLibraryPage returns { graphs, error: false } on success', async () => {
  const graphs = [{ hash: 'h1' }, { hash: 'h2' }];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ graphs }) });
  const result = await fetchLocalGraphLibraryPage();
  assert.deepEqual(result, { graphs, error: false });
});

test('fetchLocalGraphLibraryPage returns { graphs: [], error: true } on a non-ok response, never throws', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  const result = await fetchLocalGraphLibraryPage();
  assert.deepEqual(result, { graphs: [], error: true });
});

test('fetchLocalGraphLibraryPage returns { graphs: [], error: true } when fetch itself rejects, never throws', async () => {
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const result = await fetchLocalGraphLibraryPage();
  assert.deepEqual(result, { graphs: [], error: true });
});

// --- updateLocalGraphMetadata (rename/favorite/tags/notes) ----------------

test('updateLocalGraphMetadata PATCHes the hash-specific route with the updates as JSON', async () => {
  let capturedUrl;
  let capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url; capturedOptions = options;
    return { ok: true, json: async () => ({ updated: true, metadata: { hash: 'h1', favorite: true } }) };
  };
  const result = await updateLocalGraphMetadata('h1', { favorite: true });
  assert.match(capturedUrl, /\/api\/local-graphs\/h1$/);
  assert.equal(capturedOptions.method, 'PATCH');
  assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capturedOptions.body), { favorite: true });
  assert.deepEqual(result, { ok: true, metadata: { hash: 'h1', favorite: true } });
});

test('updateLocalGraphMetadata URL-encodes the hash', async () => {
  let capturedUrl;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ metadata: {} }) }; };
  await updateLocalGraphMetadata('alg1|code(a b)', {});
  assert.ok(capturedUrl.includes(encodeURIComponent('alg1|code(a b)')));
});

test('updateLocalGraphMetadata returns { ok: false } (never throws) on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  assert.deepEqual(await updateLocalGraphMetadata('h1', {}), { ok: false });
});

test('updateLocalGraphMetadata returns { ok: false } (never throws) when fetch itself rejects', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.deepEqual(await updateLocalGraphMetadata('h1', {}), { ok: false });
});

// --- deleteLocalGraph ------------------------------------------------------

test('deleteLocalGraph DELETEs the hash-specific route and returns true on success', async () => {
  let capturedUrl;
  let capturedOptions;
  globalThis.fetch = async (url, options) => {
    capturedUrl = url; capturedOptions = options;
    return { ok: true, json: async () => ({ deleted: true }) };
  };
  const result = await deleteLocalGraph('h1');
  assert.match(capturedUrl, /\/api\/local-graphs\/h1$/);
  assert.equal(capturedOptions.method, 'DELETE');
  assert.equal(result, true);
});

test('deleteLocalGraph returns false (never throws) on a non-ok response', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await deleteLocalGraph('h1'), false);
});

test('deleteLocalGraph returns false (never throws) when fetch itself rejects', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  assert.equal(await deleteLocalGraph('h1'), false);
});
