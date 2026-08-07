import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserGraphDatabase, GRAPH_VISIBILITY } from '../src/graphLibrary/browserGraphDatabaseStore.js';

// A minimal in-memory {getItem, setItem, removeItem} backend, mirroring
// tests/workspace-manager.test.mjs's own createMemoryBackend() pattern —
// every test gets its own fresh instance, so no state ever leaks between
// tests (unlike the real default backend, which is one shared
// window.localStorage across an entire browser tab).
const createMemoryBackend = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
  };
};

const PARAMS = { sequenceText: '3 1 7 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 10 };
const POINTS = [{ a: 15, b: 50 }, { a: 15.1, b: 49.9 }];

test('saveGraph creates a new graph and loadGraph reads it back unchanged (no recomputation)', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const saved = db.saveGraph({ params: PARAMS, points: POINTS, title: 'My Graph' });
  assert.ok(saved.hash);
  assert.deepEqual(saved.points, POINTS);
  assert.equal(saved.metadata.title, 'My Graph');

  const loaded = db.loadGraph(saved.hash);
  assert.deepEqual(loaded, saved);
});

test('saveGraph stores every required field (title/owner/colour/code/angleA/angleB/angleStep/baseLength/maxBounces/tags/notes/favourite/created/modified/hash/points)', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const saved = db.saveGraph({
    params: PARAMS, points: POINTS, title: 'Full Graph', author: 'Alice', graphColorHex: '#0284c7',
    tags: ['a', 'b'], favorite: true, visibility: GRAPH_VISIBILITY.PRIVATE, notes: 'hello', maxBounces: 300,
  });
  assert.equal(saved.metadata.title, 'Full Graph');
  assert.equal(saved.metadata.author, 'Alice');
  assert.equal(saved.metadata.graphColorHex, '#0284c7');
  assert.equal(saved.metadata.codeSequence, PARAMS.sequenceText);
  assert.equal(saved.metadata.angleA, PARAMS.angleA);
  assert.equal(saved.metadata.angleB, PARAMS.angleB);
  assert.equal(saved.metadata.angleStep, PARAMS.angleStepInput);
  assert.equal(saved.metadata.baseLength, PARAMS.baseLength);
  assert.equal(saved.metadata.maxBounces, 300);
  assert.deepEqual(saved.metadata.tags, ['a', 'b']);
  assert.equal(saved.metadata.favorite, true);
  assert.ok(saved.metadata.createdAt);
  assert.ok(saved.metadata.modifiedAt);
  assert.ok(saved.metadata.hash);
  assert.equal(saved.notes, 'hello');
  assert.deepEqual(saved.points, POINTS);
});

test('saveGraph autosaves immediately: a second store instance over the same backend sees it right away', () => {
  const backend = createMemoryBackend();
  const writer = createBrowserGraphDatabase(backend);
  const saved = writer.saveGraph({ params: PARAMS, points: POINTS });

  const reader = createBrowserGraphDatabase(backend);
  assert.deepEqual(reader.loadGraph(saved.hash), saved);
});

test('saveGraph upserts by hash: saving the same params again overwrites geometry/metadata but preserves id and createdAt', async () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const first = db.saveGraph({ params: PARAMS, points: POINTS, title: 'First' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = db.saveGraph({ params: PARAMS, points: [{ a: 1, b: 1 }], title: 'Second' });

  assert.equal(second.id, first.id);
  assert.equal(second.metadata.createdAt, first.metadata.createdAt);
  assert.equal(second.metadata.title, 'Second');
  assert.deepEqual(second.points, [{ a: 1, b: 1 }]);
  assert.notEqual(second.metadata.modifiedAt, first.metadata.modifiedAt);
});

test('saveGraph never clobbers existing notes when notes is omitted from a later save', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const first = db.saveGraph({ params: PARAMS, points: POINTS, notes: 'original notes' });
  const second = db.saveGraph({ params: PARAMS, points: POINTS });
  assert.equal(second.notes, 'original notes');
  assert.equal(first.hash, second.hash);
});

test('graphExists is true only after a save, false for an unknown hash', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  assert.equal(db.graphExists('never-saved'), false);
  const saved = db.saveGraph({ params: PARAMS, points: POINTS });
  assert.equal(db.graphExists(saved.hash), true);
});

test('deleteGraph removes a graph entirely; deleting an unknown hash is a harmless no-op', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const saved = db.saveGraph({ params: PARAMS, points: POINTS });
  db.deleteGraph(saved.hash);
  assert.equal(db.loadGraph(saved.hash), null);
  assert.doesNotThrow(() => db.deleteGraph('never-existed'));
});

test('updateGraphMetadata partial-updates only the given fields, leaving everything else (including points) untouched', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const saved = db.saveGraph({ params: PARAMS, points: POINTS, title: 'Original', tags: ['x'] });
  const updated = db.updateGraphMetadata(saved.hash, { favorite: true });
  assert.equal(updated.favorite, true);
  assert.equal(updated.title, 'Original');
  assert.deepEqual(updated.tags, ['x']);
  assert.deepEqual(db.loadGraph(saved.hash).points, POINTS);
});

test('updateGraphMetadata throws for a hash that was never saved', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  assert.throws(() => db.updateGraphMetadata('missing', { favorite: true }), /No graph stored for hash/);
});

test('renameGraph is a thin wrapper over updateGraphMetadata({ title })', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const saved = db.saveGraph({ params: PARAMS, points: POINTS });
  const updated = db.renameGraph(saved.hash, 'Renamed');
  assert.equal(updated.title, 'Renamed');
});

test('listGraphs returns metadata only (never points), sorted newest-first by default', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const a = db.saveGraph({ params: { ...PARAMS, sequenceText: 'A' }, points: POINTS, title: 'A' });
  const b = db.saveGraph({ params: { ...PARAMS, sequenceText: 'B' }, points: POINTS, title: 'B' });
  const list = db.listGraphs();
  assert.equal(list.length, 2);
  assert.ok(!('points' in list[0]));
  assert.deepEqual(list.map((m) => m.hash).sort(), [a.hash, b.hash].sort());
});

test('listGraphs sorts by title ascending when asked', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  db.saveGraph({ params: { ...PARAMS, sequenceText: 'A' }, points: POINTS, title: 'Zebra' });
  db.saveGraph({ params: { ...PARAMS, sequenceText: 'B' }, points: POINTS, title: 'Apple' });
  const list = db.listGraphs({ sortBy: 'title', order: 'asc' });
  assert.deepEqual(list.map((m) => m.title), ['Apple', 'Zebra']);
});

test('searchGraphs text query matches across title/code/tags/notes/owner/hash', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const target = db.saveGraph({ params: { ...PARAMS, sequenceText: 'UNIQUECODE' }, points: POINTS, title: 'Nothing Special', author: 'Bob', notes: 'a distinctive note' });
  db.saveGraph({ params: { ...PARAMS, sequenceText: 'OTHER' }, points: POINTS, title: 'Different' });

  assert.deepEqual(db.searchGraphs({ text: 'UNIQUECODE' }).map((m) => m.hash), [target.hash]);
  assert.deepEqual(db.searchGraphs({ text: 'distinctive' }).map((m) => m.hash), [target.hash]);
  assert.deepEqual(db.searchGraphs({ text: 'bob' }).map((m) => m.hash), [target.hash]);
});

test('searchGraphs structured filters (favorite, tags, angleA) are ANDed together', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const match = db.saveGraph({ params: { ...PARAMS, sequenceText: 'M' }, points: POINTS, favorite: true, tags: ['keep'] });
  db.saveGraph({ params: { ...PARAMS, sequenceText: 'N' }, points: POINTS, favorite: false, tags: ['keep'] });
  const results = db.searchGraphs({ favorite: true, tags: ['keep'] });
  assert.deepEqual(results.map((m) => m.hash), [match.hash]);
});

test('exportDatabase returns every full graph record (metadata + points + notes), suitable for round-tripping without recomputation', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const saved = db.saveGraph({ params: PARAMS, points: POINTS, title: 'Exportable', notes: 'notes here' });
  const exported = db.exportDatabase();
  assert.equal(exported.graphs.length, 1);
  assert.deepEqual(exported.graphs[0], saved);
});

test('importDatabase imports unique graphs and skips graphs whose hash already exists locally', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  const existing = db.saveGraph({ params: { ...PARAMS, sequenceText: 'EXISTING' }, points: POINTS, title: 'Already here' });

  const incomingNew = { id: 'incoming-1', hash: 'brand-new-hash', metadata: { id: 'incoming-1', hash: 'brand-new-hash', title: 'Imported', author: 'Someone Else' }, points: [{ a: 9, b: 9 }], notes: '' };
  const incomingDuplicate = { id: existing.id, hash: existing.hash, metadata: { ...existing.metadata, title: 'Would overwrite' }, points: [], notes: '' };

  const result = db.importDatabase({ graphs: [incomingNew, incomingDuplicate] });
  assert.deepEqual(result, { imported: 1, duplicates: 1, total: 2 });

  // The duplicate must never have overwritten the existing local graph.
  assert.equal(db.loadGraph(existing.hash).metadata.title, 'Already here');
  // The genuinely new graph is now present, with its own owner preserved.
  const imported = db.loadGraph('brand-new-hash');
  assert.equal(imported.metadata.author, 'Someone Else');
  assert.deepEqual(imported.points, [{ a: 9, b: 9 }]);
});

test('importDatabase reports accurate imported/duplicate/total counts across a full export -> import round trip', () => {
  const sourceDb = createBrowserGraphDatabase(createMemoryBackend());
  sourceDb.saveGraph({ params: { ...PARAMS, sequenceText: 'ONE' }, points: POINTS, author: 'Alice' });
  sourceDb.saveGraph({ params: { ...PARAMS, sequenceText: 'TWO' }, points: POINTS, author: 'Alice' });
  const exported = sourceDb.exportDatabase();

  const destinationDb = createBrowserGraphDatabase(createMemoryBackend());
  const firstImport = destinationDb.importDatabase(exported);
  assert.deepEqual(firstImport, { imported: 2, duplicates: 0, total: 2 });

  // Importing the exact same export again must be a full no-op (all duplicates).
  const secondImport = destinationDb.importDatabase(exported);
  assert.deepEqual(secondImport, { imported: 0, duplicates: 2, total: 2 });

  // Owner is preserved from the exporting browser, not the importing one.
  for (const metadata of destinationDb.listGraphs()) {
    assert.equal(metadata.author, 'Alice');
  }
});

test('importDatabase tolerates malformed/empty input without throwing', () => {
  const db = createBrowserGraphDatabase(createMemoryBackend());
  assert.deepEqual(db.importDatabase({}), { imported: 0, duplicates: 0, total: 0 });
  assert.deepEqual(db.importDatabase({ graphs: [] }), { imported: 0, duplicates: 0, total: 0 });
  assert.deepEqual(db.importDatabase({ graphs: [{ notAGraph: true }] }), { imported: 0, duplicates: 0, total: 0 });
  assert.deepEqual(db.importDatabase(null), { imported: 0, duplicates: 0, total: 0 });
});

test('multiple independent backends do not interfere with each other', () => {
  const dbOne = createBrowserGraphDatabase(createMemoryBackend());
  const dbTwo = createBrowserGraphDatabase(createMemoryBackend());
  dbOne.saveGraph({ params: PARAMS, points: POINTS, title: 'Only in one' });
  assert.equal(dbOne.listGraphs().length, 1);
  assert.equal(dbTwo.listGraphs().length, 0);
});

test('a corrupt (non-JSON) stored blob is treated as an empty database rather than throwing', () => {
  const backend = createMemoryBackend();
  backend.setItem('illuminable-graph-database', 'not json at all {{{');
  const db = createBrowserGraphDatabase(backend);
  assert.deepEqual(db.listGraphs(), []);
  assert.doesNotThrow(() => db.saveGraph({ params: PARAMS, points: POINTS }));
});
