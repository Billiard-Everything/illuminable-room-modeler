// localGraphDatabaseClient.js now persists directly to the browser's own
// storage (see browserGraphDatabaseStore.js) instead of making HTTP calls,
// so its default backend reads/writes `window.localStorage` — a plain
// in-memory shim stands in for that here, set up via dynamic import (static
// imports are always hoisted ahead of any other top-level code, so a plain
// `import` of the client above a `globalThis.window = ...` assignment would
// still see `window` undefined the moment the client module's own
// transitive import of browserGraphDatabaseStore.js evaluates).
import assert from 'node:assert/strict';
import test from 'node:test';

const memoryStorage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (memoryStorage.has(key) ? memoryStorage.get(key) : null),
    setItem: (key, value) => { memoryStorage.set(key, value); },
    removeItem: (key) => { memoryStorage.delete(key); },
  },
};

const {
  fetchLocalExactGraph, saveLocalExactGraph, fetchLocalGraphDetails,
  fetchLocalGraphLibraryPage, updateLocalGraphMetadata, deleteLocalGraph,
  exportLocalGraphDatabase, importLocalGraphDatabase,
} = await import('../src/anglePlot/localGraphDatabaseClient.js');

// Every test gets a clean slate — the underlying store is one shared
// singleton (module-level, matching a real browser tab's one localStorage),
// so without this, an earlier test's saved graph would leak into a later
// one's listing/search assertions.
test.beforeEach(() => { memoryStorage.clear(); });

const PARAMS = { sequenceText: '3 1 7 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 10 };
const POINTS = [{ a: 15, b: 50 }, { a: 15.1, b: 49.9 }];

test('fetchLocalExactGraph returns null for a hash that was never saved', async () => {
  assert.equal(await fetchLocalExactGraph('never-saved'), null);
});

test('saveLocalExactGraph then fetchLocalExactGraph round-trips points and durationMs', async () => {
  const ok = await saveLocalExactGraph(PARAMS, 1, POINTS, 500);
  assert.equal(ok, true);
  const hash = (await exportLocalGraphDatabase()).graphs[0].hash;
  const result = await fetchLocalExactGraph(hash);
  assert.deepEqual(result, { points: POINTS, durationMs: 500 });
});

test('fetchLocalExactGraph defaults durationMs to null when none was saved', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, null);
  const hash = (await exportLocalGraphDatabase()).graphs[0].hash;
  const result = await fetchLocalExactGraph(hash);
  assert.equal(result.durationMs, null);
});

test('saveLocalExactGraph persists title/graphColorHex/notes/tags/favorite/visibility/maxBounces when provided', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, 500, {
    title: 'My Graph', graphColorHex: '#0284c7', notes: 'some notes', tags: ['a', 'b'], favorite: true, visibility: 'public', maxBounces: 300,
  });
  const { metadata, notes } = (await exportLocalGraphDatabase()).graphs[0];
  assert.equal(metadata.title, 'My Graph');
  assert.equal(metadata.graphColorHex, '#0284c7');
  assert.equal(notes, 'some notes');
  assert.deepEqual(metadata.tags, ['a', 'b']);
  assert.equal(metadata.favorite, true);
  assert.equal(metadata.visibility, 'public');
  assert.equal(metadata.maxBounces, 300);
});

test('saveLocalExactGraph resolves to true on success and never throws', async () => {
  await assert.doesNotReject(() => saveLocalExactGraph(PARAMS, 1, POINTS, null));
  assert.equal(await saveLocalExactGraph(PARAMS, 1, POINTS, null), true);
});

test('fetchLocalGraphDetails returns points+durationMs+notes together', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, 42, { notes: 'my notes' });
  const hash = (await exportLocalGraphDatabase()).graphs[0].hash;
  const result = await fetchLocalGraphDetails(hash);
  assert.deepEqual(result, { points: POINTS, durationMs: 42, notes: 'my notes' });
});

test('fetchLocalGraphDetails defaults notes to an empty string when absent', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, null);
  const hash = (await exportLocalGraphDatabase()).graphs[0].hash;
  assert.equal((await fetchLocalGraphDetails(hash)).notes, '');
});

test('fetchLocalGraphDetails returns null for an unknown hash', async () => {
  assert.equal(await fetchLocalGraphDetails('unknown'), null);
});

test('fetchLocalGraphLibraryPage with no search fields lists every saved graph', async () => {
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'A' }, 1, POINTS, null);
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'B' }, 1, POINTS, null);
  const result = await fetchLocalGraphLibraryPage();
  assert.equal(result.error, false);
  assert.equal(result.graphs.length, 2);
});

test('fetchLocalGraphLibraryPage search.text filters to matching graphs only', async () => {
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'UNIQUECODE' }, 1, POINTS, null, { title: 'Match' });
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'OTHER' }, 1, POINTS, null, { title: 'NoMatch' });
  const result = await fetchLocalGraphLibraryPage({ search: { text: 'UNIQUECODE' } });
  assert.equal(result.graphs.length, 1);
  assert.equal(result.graphs[0].title, 'Match');
});

test('fetchLocalGraphLibraryPage respects limit/offset for pagination', async () => {
  for (let i = 0; i < 5; i++) {
    await saveLocalExactGraph({ ...PARAMS, sequenceText: `code-${i}` }, 1, POINTS, null);
  }
  const page = await fetchLocalGraphLibraryPage({ limit: 2, offset: 2 });
  assert.equal(page.graphs.length, 2);
});

test('fetchLocalGraphLibraryPage sorts by the requested sort value', async () => {
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'Z' }, 1, POINTS, null, { title: 'Zebra' });
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'A' }, 1, POINTS, null, { title: 'Apple' });
  const result = await fetchLocalGraphLibraryPage({ sort: 'title_asc' });
  assert.deepEqual(result.graphs.map((g) => g.title), ['Apple', 'Zebra']);
});

test('fetchLocalGraphLibraryPage never throws even against a corrupt stored blob', async () => {
  memoryStorage.set('illuminable-graph-database', 'not json {{{');
  const result = await fetchLocalGraphLibraryPage();
  assert.deepEqual(result, { graphs: [], error: false });
});

test('updateLocalGraphMetadata updates and persists the given fields', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, null, { title: 'Original' });
  const hash = (await exportLocalGraphDatabase()).graphs[0].hash;
  const result = await updateLocalGraphMetadata(hash, { favorite: true });
  assert.equal(result.ok, true);
  assert.equal(result.metadata.favorite, true);
  assert.equal(result.metadata.title, 'Original');
});

test('updateLocalGraphMetadata returns { ok: false } (never throws) for an unknown hash', async () => {
  assert.deepEqual(await updateLocalGraphMetadata('unknown', { favorite: true }), { ok: false });
});

test('deleteLocalGraph removes the graph and returns true', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, null);
  const hash = (await exportLocalGraphDatabase()).graphs[0].hash;
  assert.equal(await deleteLocalGraph(hash), true);
  assert.equal(await fetchLocalExactGraph(hash), null);
});

test('deleteLocalGraph on an already-absent hash still resolves without throwing', async () => {
  await assert.doesNotReject(() => deleteLocalGraph('never-existed'));
});

test('exportLocalGraphDatabase then importLocalGraphDatabase (into a cleared store) restores every graph', async () => {
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'ONE' }, 1, POINTS, null, { title: 'One' });
  await saveLocalExactGraph({ ...PARAMS, sequenceText: 'TWO' }, 1, POINTS, null, { title: 'Two' });
  const exported = await exportLocalGraphDatabase();

  memoryStorage.clear();
  const result = await importLocalGraphDatabase(exported);
  assert.deepEqual(result, { imported: 2, duplicates: 0, total: 2 });
  const page = await fetchLocalGraphLibraryPage();
  assert.equal(page.graphs.length, 2);
});

test('importLocalGraphDatabase skips graphs that already exist locally (by hash) and reports the duplicate count', async () => {
  await saveLocalExactGraph(PARAMS, 1, POINTS, null, { title: 'Already here' });
  const exported = await exportLocalGraphDatabase(); // exports the one graph just saved
  const result = await importLocalGraphDatabase(exported);
  assert.deepEqual(result, { imported: 0, duplicates: 1, total: 1 });
});
