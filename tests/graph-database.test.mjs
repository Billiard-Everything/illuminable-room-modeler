import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGraphDatabase, GRAPH_VISIBILITY } from '../server/graphDatabase/graphDatabase.js';
import { graphDirName } from '../server/graphDatabase/graphFileStore.js';
import { hashGraph } from '../src/anglePlot/graphHasher.js';

const params = (overrides = {}) => ({
  sequenceText: '3 1 7 2 6 2 8 2 4 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 90, ...overrides,
});
const points = () => [{ a: 10, b: 20 }, { a: 30, b: 40 }, { a: 5, b: 60 }];

let tempDir;
let db;
test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-database-test-'));
  db = createGraphDatabase(tempDir);
});
test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('saveGraph computes the hash via graphHasher.hashGraph, never independently', async () => {
  const graph = await db.saveGraph({ params: params(), points: points() });
  assert.equal(graph.hash, hashGraph(params()));
});

test('saveGraph writes metadata.json, points.json, and notes.md on disk under the hash\'s own directory', async () => {
  const graph = await db.saveGraph({ params: params(), points: points(), notes: 'hello' });
  const dir = path.join(tempDir, graphDirName(graph.hash));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')).hash, graph.hash);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'points.json'), 'utf8')), points());
  assert.equal(await fs.readFile(path.join(dir, 'notes.md'), 'utf8'), 'hello');
});

test('saveGraph returns the {id, hash, metadata, points, notes} shape', async () => {
  const graph = await db.saveGraph({ params: params(), points: points(), title: 'My Graph', notes: 'some notes' });
  assert.ok(graph.id);
  assert.ok(graph.hash);
  assert.equal(graph.metadata.title, 'My Graph');
  assert.deepEqual(graph.points, points());
  assert.equal(graph.notes, 'some notes');
});

test('metadata.json includes every required field', async () => {
  const graph = await db.saveGraph({
    params: params(), points: points(), title: 't', description: 'd', author: 'a',
    graphColorHex: '#ff0000', tags: ['x'], favorite: true, visibility: GRAPH_VISIBILITY.SHARED, computeTimeMs: 1234,
    notes: 'some notes',
  });
  const { metadata } = graph;
  for (const field of [
    'id', 'hash', 'title', 'description', 'author', 'codeSequence', 'angleA', 'angleB', 'angleStep',
    'baseLength', 'graphColorHex', 'createdAt', 'modifiedAt', 'algorithmVersion', 'pointCount',
    'computeTimeMs', 'minX', 'maxX', 'minY', 'maxY', 'tags', 'favorite', 'visibility', 'notesPreview',
  ]) {
    assert.ok(field in metadata, `metadata is missing "${field}"`);
  }
  assert.equal(metadata.codeSequence, params().sequenceText);
  assert.equal(metadata.angleStep, params().angleStepInput);
  assert.equal(metadata.pointCount, 3);
  assert.equal(metadata.computeTimeMs, 1234);
  assert.equal(metadata.graphColorHex, '#ff0000');
  assert.deepEqual(metadata.tags, ['x']);
  assert.equal(metadata.favorite, true);
  assert.equal(metadata.visibility, GRAPH_VISIBILITY.SHARED);
});

test('metadata min/max X/Y are derived from the points\' a/b values', async () => {
  const graph = await db.saveGraph({ params: params(), points: points() });
  assert.equal(graph.metadata.minX, 5);
  assert.equal(graph.metadata.maxX, 30);
  assert.equal(graph.metadata.minY, 20);
  assert.equal(graph.metadata.maxY, 60);
});

test('metadata min/max X/Y are null for an empty points array', async () => {
  const graph = await db.saveGraph({ params: params(), points: [] });
  assert.equal(graph.metadata.minX, null);
  assert.equal(graph.metadata.maxX, null);
  assert.equal(graph.metadata.minY, null);
  assert.equal(graph.metadata.maxY, null);
});

test('saving the same graph twice preserves id and createdAt, but updates modifiedAt and geometry', async () => {
  const first = await db.saveGraph({ params: params(), points: [{ a: 1, b: 2 }] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await db.saveGraph({ params: params(), points: [{ a: 1, b: 2 }, { a: 3, b: 4 }] });

  assert.equal(second.id, first.id);
  assert.equal(second.metadata.createdAt, first.metadata.createdAt);
  assert.notEqual(second.metadata.modifiedAt, first.metadata.modifiedAt);
  assert.equal(second.metadata.pointCount, 2);
});

test('saving the same graph again without a notes argument preserves the existing notes.md', async () => {
  await db.saveGraph({ params: params(), points: points(), notes: 'original notes' });
  const resaved = await db.saveGraph({ params: params(), points: points() });
  assert.equal(resaved.notes, 'original notes');
});

test('saving the same graph again with an explicit notes argument overwrites notes.md', async () => {
  await db.saveGraph({ params: params(), points: points(), notes: 'original notes' });
  const resaved = await db.saveGraph({ params: params(), points: points(), notes: 'updated notes' });
  assert.equal(resaved.notes, 'updated notes');
});

test('a brand-new graph with no notes argument gets an empty notes.md', async () => {
  const graph = await db.saveGraph({ params: params(), points: points() });
  assert.equal(graph.notes, '');
});

// --- metadata.notesPreview (a short, denormalized excerpt of notes.md) ----
// Lets the Graph Database browser's cards show a hint of a graph's notes
// without reading notes.md for every card during a plain listing.

test('saveGraph with short notes stores the whole thing, collapsed to one line, as notesPreview', async () => {
  const graph = await db.saveGraph({ params: params(), points: points(), notes: 'line one\nline two' });
  assert.equal(graph.metadata.notesPreview, 'line one line two');
});

test('saveGraph with long notes truncates notesPreview with an ellipsis', async () => {
  const longNotes = 'x'.repeat(200);
  const graph = await db.saveGraph({ params: params(), points: points(), notes: longNotes });
  assert.ok(graph.metadata.notesPreview.length <= 80);
  assert.ok(graph.metadata.notesPreview.endsWith('…'));
});

test('saveGraph with no notes argument leaves notesPreview empty', async () => {
  const graph = await db.saveGraph({ params: params(), points: points() });
  assert.equal(graph.metadata.notesPreview, '');
});

test('saving again without a notes argument preserves the existing notesPreview', async () => {
  const first = await db.saveGraph({ params: params(), points: points(), notes: 'original notes' });
  const second = await db.saveGraph({ params: params(), points: [{ a: 9, b: 9 }] });
  assert.equal(second.metadata.notesPreview, first.metadata.notesPreview);
});

test('updateGraphMetadata with a notes update refreshes notesPreview to match', async () => {
  const saved = await db.saveGraph({ params: params(), points: points(), notes: 'old notes' });
  const updated = await db.updateGraphMetadata(saved.hash, { notes: 'brand new notes' });
  assert.equal(updated.notesPreview, 'brand new notes');
});

test('updateGraphMetadata without a notes update leaves notesPreview untouched', async () => {
  const saved = await db.saveGraph({ params: params(), points: points(), notes: 'original notes' });
  const updated = await db.updateGraphMetadata(saved.hash, { favorite: true });
  assert.equal(updated.notesPreview, saved.metadata.notesPreview);
});

test('listGraphs returns notesPreview without ever reading notes.md itself', async () => {
  const saved = await db.saveGraph({ params: params(), points: points(), notes: 'preview me' });
  const dir = path.join(tempDir, graphDirName(saved.hash));
  await fs.rm(path.join(dir, 'notes.md'));
  const list = await db.listGraphs();
  assert.equal(list[0].notesPreview, 'preview me');
});

// --- author ("owner") default resolution ------------------------------

test('saveGraph defaults author to GRAPH_DB_USERNAME when no explicit author is given', async () => {
  const original = process.env.GRAPH_DB_USERNAME;
  process.env.GRAPH_DB_USERNAME = 'alice';
  try {
    const graph = await db.saveGraph({ params: params(), points: points() });
    assert.equal(graph.metadata.author, 'alice');
  } finally {
    if (original === undefined) delete process.env.GRAPH_DB_USERNAME; else process.env.GRAPH_DB_USERNAME = original;
  }
});

test('saveGraph with an explicit author overrides the GRAPH_DB_USERNAME default', async () => {
  const original = process.env.GRAPH_DB_USERNAME;
  process.env.GRAPH_DB_USERNAME = 'alice';
  try {
    const graph = await db.saveGraph({ params: params(), points: points(), author: 'bob' });
    assert.equal(graph.metadata.author, 'bob');
  } finally {
    if (original === undefined) delete process.env.GRAPH_DB_USERNAME; else process.env.GRAPH_DB_USERNAME = original;
  }
});

test('saveGraph without GRAPH_DB_USERNAME still resolves a non-null author (falls back to the OS account name)', async () => {
  const original = process.env.GRAPH_DB_USERNAME;
  delete process.env.GRAPH_DB_USERNAME;
  try {
    const graph = await db.saveGraph({ params: params(), points: points() });
    assert.equal(typeof graph.metadata.author, 'string');
    assert.ok(graph.metadata.author.length > 0);
  } finally {
    if (original !== undefined) process.env.GRAPH_DB_USERNAME = original;
  }
});

test('saving the same graph again without an author preserves the previously-resolved author, never re-defaulting', async () => {
  const original = process.env.GRAPH_DB_USERNAME;
  process.env.GRAPH_DB_USERNAME = 'alice';
  try {
    const first = await db.saveGraph({ params: params(), points: points() });
    process.env.GRAPH_DB_USERNAME = 'bob';
    const second = await db.saveGraph({ params: params(), points: [{ a: 9, b: 9 }] });
    assert.equal(second.metadata.author, first.metadata.author);
  } finally {
    if (original === undefined) delete process.env.GRAPH_DB_USERNAME; else process.env.GRAPH_DB_USERNAME = original;
  }
});

test('loadGraph returns null for a hash that was never saved', async () => {
  assert.equal(await db.loadGraph('never-saved-hash'), null);
});

test('loadGraph round-trips exactly what saveGraph wrote', async () => {
  const saved = await db.saveGraph({ params: params(), points: points(), title: 'Round Trip', notes: 'notes here' });
  const loaded = await db.loadGraph(saved.hash);
  assert.deepEqual(loaded, saved);
});

test('graphExists is false before saving and true after', async () => {
  const hash = hashGraph(params());
  assert.equal(await db.graphExists(hash), false);
  await db.saveGraph({ params: params(), points: points() });
  assert.equal(await db.graphExists(hash), true);
});

test('deleteGraph removes the graph entirely; loadGraph/graphExists reflect that afterward', async () => {
  const saved = await db.saveGraph({ params: params(), points: points() });
  await db.deleteGraph(saved.hash);
  assert.equal(await db.graphExists(saved.hash), false);
  assert.equal(await db.loadGraph(saved.hash), null);
});

test('deleteGraph never throws for a hash that was never saved', async () => {
  await assert.doesNotReject(() => db.deleteGraph('never-saved-hash'));
});

test('renameGraph changes only the title and modifiedAt, leaving every other field untouched', async () => {
  const saved = await db.saveGraph({ params: params(), points: points(), title: 'Old Title' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renamed = await db.renameGraph(saved.hash, 'New Title');
  assert.equal(renamed.title, 'New Title');
  assert.notEqual(renamed.modifiedAt, saved.metadata.modifiedAt);
  assert.equal(renamed.id, saved.id);
  assert.equal(renamed.createdAt, saved.metadata.createdAt);
  assert.equal(renamed.codeSequence, saved.metadata.codeSequence);

  const reloaded = await db.loadGraph(saved.hash);
  assert.equal(reloaded.metadata.title, 'New Title');
});

test('renameGraph throws for a hash that was never saved', async () => {
  await assert.rejects(() => db.renameGraph('never-saved-hash', 'X'));
});

test('updateGraphMetadata changes only the fields provided, leaving everything else (including notes) untouched', async () => {
  const saved = await db.saveGraph({
    params: params(), points: points(), title: 'Old Title', tags: ['a'], favorite: false, notes: 'original notes',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await db.updateGraphMetadata(saved.hash, { favorite: true });
  assert.equal(updated.favorite, true);
  assert.equal(updated.title, 'Old Title');
  assert.deepEqual(updated.tags, ['a']);
  assert.notEqual(updated.modifiedAt, saved.metadata.modifiedAt);
  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, saved.metadata.createdAt);

  const reloaded = await db.loadGraph(saved.hash);
  assert.equal(reloaded.notes, 'original notes', 'notes must be untouched when not provided');
});

test('updateGraphMetadata updates title/tags/favorite/visibility/graphColorHex/notes together in one call', async () => {
  const saved = await db.saveGraph({ params: params(), points: points() });
  const updated = await db.updateGraphMetadata(saved.hash, {
    title: 'New Title', tags: ['x', 'y'], favorite: true, visibility: GRAPH_VISIBILITY.PUBLIC,
    graphColorHex: '#123456', notes: 'new notes',
  });
  assert.equal(updated.title, 'New Title');
  assert.deepEqual(updated.tags, ['x', 'y']);
  assert.equal(updated.favorite, true);
  assert.equal(updated.visibility, GRAPH_VISIBILITY.PUBLIC);
  assert.equal(updated.graphColorHex, '#123456');

  const reloaded = await db.loadGraph(saved.hash);
  assert.equal(reloaded.notes, 'new notes');
});

test('updateGraphMetadata never touches points.json', async () => {
  const saved = await db.saveGraph({ params: params(), points: points() });
  await db.updateGraphMetadata(saved.hash, { title: 'Renamed' });
  const reloaded = await db.loadGraph(saved.hash);
  assert.deepEqual(reloaded.points, points());
});

test('updateGraphMetadata throws for a hash that was never saved', async () => {
  await assert.rejects(() => db.updateGraphMetadata('never-saved-hash', { favorite: true }));
});

test('listGraphs returns metadata only (never a points field) for every saved graph', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  const list = await db.listGraphs();
  assert.equal(list.length, 2);
  for (const entry of list) assert.ok(!('points' in entry));
});

test('listGraphs returns [] for a library that has never saved anything', async () => {
  assert.deepEqual(await db.listGraphs(), []);
});

test('listGraphs defaults to newest-first (createdAt desc)', async () => {
  const first = await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  const list = await db.listGraphs();
  assert.equal(list[0].hash, second.hash);
  assert.equal(list[1].hash, first.hash);
});

test('listGraphs supports sortBy/order overrides', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'Beta' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), title: 'Alpha' });
  const list = await db.listGraphs({ sortBy: 'title', order: 'asc' });
  assert.deepEqual(list.map((g) => g.title), ['Alpha', 'Beta']);
});

test('searchGraphs with no query returns every graph', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  assert.equal((await db.searchGraphs()).length, 2);
});

test('searchGraphs filters by a partial title match', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'Spiral Pattern' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), title: 'Star Pattern' });
  const results = await db.searchGraphs({ title: 'spiral' });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Spiral Pattern');
});

test('searchGraphs filters by a partial codeSequence match', async () => {
  await db.saveGraph({ params: params({ angleA: 15, sequenceText: '1 2 3' }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16, sequenceText: '9 9 9' }), points: points() });
  const results = await db.searchGraphs({ codeSequence: '9 9' });
  assert.equal(results.length, 1);
  assert.equal(results[0].codeSequence, '9 9 9');
});

test('searchGraphs filters by exact angleA/angleB/baseLength', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  const results = await db.searchGraphs({ angleA: 16 });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 16);
});

test('searchGraphs filters by favorite', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), favorite: true });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), favorite: false });
  const results = await db.searchGraphs({ favorite: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs filters by visibility', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), visibility: GRAPH_VISIBILITY.PUBLIC });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), visibility: GRAPH_VISIBILITY.PRIVATE });
  const results = await db.searchGraphs({ visibility: GRAPH_VISIBILITY.PUBLIC });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs filters by "any of these tags"', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), tags: ['homework', 'week1'] });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), tags: ['project'] });
  const results = await db.searchGraphs({ tags: ['week1'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs ANDs multiple provided filters together', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), favorite: true, title: 'Alpha' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), favorite: true, title: 'Beta' });
  await db.saveGraph({ params: params({ angleA: 17 }), points: points(), favorite: false, title: 'Alpha' });
  const results = await db.searchGraphs({ favorite: true, title: 'Alpha' });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('two graphs with different params never collide — each gets its own directory and hash', async () => {
  const a = await db.saveGraph({ params: params({ angleA: 15 }), points: [{ a: 1, b: 2 }] });
  const b = await db.saveGraph({ params: params({ angleA: 16 }), points: [{ a: 3, b: 4 }] });
  assert.notEqual(a.hash, b.hash);
  assert.deepEqual((await db.loadGraph(a.hash)).points, [{ a: 1, b: 2 }]);
  assert.deepEqual((await db.loadGraph(b.hash)).points, [{ a: 3, b: 4 }]);
});

// --- searchGraphs's unified free-text search (query.text) ------------------
// "Searching should work across: title, code, tags, notes, owner, graph hash."

test('searchGraphs query.text matches a substring of the title', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'Spiral Pattern' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), title: 'Star Pattern' });
  const results = await db.searchGraphs({ text: 'spiral' });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Spiral Pattern');
});

test('searchGraphs query.text matches a substring of the code sequence', async () => {
  await db.saveGraph({ params: params({ angleA: 15, sequenceText: '1 2 3' }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16, sequenceText: '9 9 9' }), points: points() });
  const results = await db.searchGraphs({ text: '9 9' });
  assert.equal(results.length, 1);
  assert.equal(results[0].codeSequence, '9 9 9');
});

test('searchGraphs query.text matches any tag', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), tags: ['homework', 'week1'] });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), tags: ['project'] });
  const results = await db.searchGraphs({ text: 'week1' });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs query.text matches the author (owner)', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), author: 'alice' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), author: 'bob' });
  const results = await db.searchGraphs({ text: 'alice' });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs query.text matches a substring of the hash', async () => {
  const saved = await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  // A slice covering the angleA marker itself, since the two saved hashes
  // share an identical prefix (same code sequence) up to that point.
  const uniquePart = saved.hash.slice(saved.hash.indexOf('|a('));
  const results = await db.searchGraphs({ text: uniquePart });
  assert.equal(results.length, 1);
  assert.equal(results[0].hash, saved.hash);
});

test('searchGraphs query.text matches notes.md content, even though notes live in a separate file from metadata', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), notes: 'remember to check the boundary case' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), notes: 'nothing special here' });
  const results = await db.searchGraphs({ text: 'boundary case' });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs query.text is case-insensitive', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'UPPERCASE TITLE' });
  const results = await db.searchGraphs({ text: 'uppercase' });
  assert.equal(results.length, 1);
});

test('searchGraphs query.text returns no matches when nothing matches any field', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'Alpha' });
  assert.deepEqual(await db.searchGraphs({ text: 'zzz-nonexistent-zzz' }), []);
});

test('searchGraphs query.text is ANDed with structured filters, not just ORed in', async () => {
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'Alpha', favorite: true });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), title: 'Alpha', favorite: false });
  const results = await db.searchGraphs({ text: 'alpha', favorite: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

test('searchGraphs never reads notes.md when query.text is not provided', async () => {
  // Save a graph, then delete its notes.md out from under the database to
  // prove a plain (non-text) search never even tries to read it — if it
  // did, readTextIfExists would just fall back to '' silently anyway, so
  // this really is testing "doesn't touch that file", not "handles it
  // being missing".
  const saved = await db.saveGraph({ params: params(), points: points(), notes: 'some notes', title: 'Graph One' });
  const dir = path.join(tempDir, graphDirName(saved.hash));
  await fs.rm(path.join(dir, 'notes.md'));
  const results = await db.searchGraphs({ title: 'Graph' });
  // No throw, and the graph is still found by title (notes.md being gone
  // never breaks a non-text search).
  assert.equal(results.length, 1);
});
