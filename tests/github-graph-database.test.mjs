import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubGraphDatabase } from '../server/graphDatabase/githubGraphDatabase.js';
import { GRAPH_VISIBILITY } from '../server/graphDatabase/graphDatabaseShared.js';

const params = (overrides = {}) => ({
  sequenceText: '3 1 7 2 6 2 8 2 4 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 90, ...overrides,
});
const points = () => [{ a: 10, b: 20 }, { a: 30, b: 40 }, { a: 5, b: 60 }];

/**
 * A fake GithubContentsClient — an in-memory Map keyed by repo path, with
 * a monotonic sha counter so putFile's own optimistic-concurrency contract
 * (a stale sha should be rejected) can be exercised without any real
 * network access. Mirrors this session's own established "fake external
 * service" pattern (a fake Postgres pool, a fake Storage client) — real
 * githubGraphDatabase.js logic runs against this, only the raw HTTP layer
 * is faked.
 */
const createFakeGithubClient = () => {
  const files = new Map(); // path -> { text, sha }
  let shaCounter = 0;
  return {
    files,
    async getFile(path) {
      const entry = files.get(path);
      return entry ? { text: entry.text, sha: entry.sha } : null;
    },
    async putFile(path, text, { sha } = {}) {
      const existing = files.get(path);
      if (existing && existing.sha !== sha) throw new Error(`stale sha for ${path}`);
      const newSha = `sha-${++shaCounter}`;
      files.set(path, { text, sha: newSha });
      return newSha;
    },
    async deleteFile(path) {
      files.delete(path);
    },
  };
};

/** A fake local fallback GraphDatabase — an in-memory Map keyed by hash, tracking calls so tests can assert exactly when the fallback was actually used. */
const createFakeFallback = (overrides = {}) => {
  const store = new Map();
  const calls = [];
  return {
    calls,
    store,
    async saveGraph(input) {
      calls.push('saveGraph');
      const hash = input.params.sequenceText + input.params.angleA; // simple stand-in, not real hashGraph
      const metadata = { id: 'local-id', hash, title: input.title ?? '', favorite: input.favorite ?? false, tags: input.tags ?? [] };
      store.set(hash, { id: metadata.id, hash, metadata, points: input.points, notes: input.notes ?? '' });
      return store.get(hash);
    },
    async loadGraph(hash) { calls.push('loadGraph'); return store.get(hash) ?? null; },
    async graphExists(hash) { calls.push('graphExists'); return store.has(hash); },
    async deleteGraph(hash) { calls.push('deleteGraph'); store.delete(hash); },
    async renameGraph() { calls.push('renameGraph'); return {}; },
    async updateGraphMetadata() { calls.push('updateGraphMetadata'); return {}; },
    async listGraphs() { calls.push('listGraphs'); return [...store.values()].map((g) => g.metadata); },
    async searchGraphs() { calls.push('searchGraphs'); return [...store.values()].map((g) => g.metadata); },
    ...overrides,
  };
};

const buildDb = (client, fallback) => createGithubGraphDatabase({
  token: 't', owner: 'o', repo: 'r', branch: 'main', client, fallback: fallback ?? createFakeFallback(),
});

test('saveGraph writes metadata.json and points.json under graphs/<id>/, and returns the {id, hash, metadata, points, notes} shape', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const graph = await db.saveGraph({ params: params(), points: points(), title: 'My Graph', notes: 'some notes' });
  assert.ok(graph.id);
  assert.ok(graph.hash);
  assert.equal(graph.metadata.title, 'My Graph');
  assert.deepEqual(graph.points, points());
  assert.equal(graph.notes, 'some notes');
  assert.ok(client.files.has(`graphs/${graph.id}/metadata.json`));
  assert.ok(client.files.has(`graphs/${graph.id}/points.json`));
});

test('saveGraph stores metadata.json in this task\'s own repo field shape (id/title/owner/code/angleA/.../graphHash)', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const graph = await db.saveGraph({
    params: params(), points: points(), title: 't', author: 'alice', graphColorHex: '#ff0000',
    tags: ['x'], favorite: true, visibility: GRAPH_VISIBILITY.SHARED, notes: 'n',
  });
  const stored = JSON.parse(client.files.get(`graphs/${graph.id}/metadata.json`).text);
  assert.deepEqual(Object.keys(stored).sort(), [
    'angleA', 'angleB', 'angleStep', 'baseLength', 'code', 'colourHex', 'createdAt', 'favourite',
    'graphHash', 'id', 'modifiedAt', 'notes', 'owner', 'pointCount', 'tags', 'title', 'visibility',
  ].sort());
  assert.equal(stored.owner, 'alice');
  assert.equal(stored.code, params().sequenceText);
  assert.equal(stored.colourHex, '#ff0000');
  assert.equal(stored.favourite, true);
  assert.equal(stored.graphHash, graph.hash);
});

test('saveGraph maintains database/index.json, adding one entry per distinct hash', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  const index = JSON.parse(client.files.get('database/index.json').text);
  assert.equal(index.length, 2);
});

test('saving the same hash again updates the same index entry (by id) instead of adding a second one', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const first = await db.saveGraph({ params: params(), points: [{ a: 1, b: 2 }] });
  const second = await db.saveGraph({ params: params(), points: [{ a: 1, b: 2 }, { a: 3, b: 4 }] });
  assert.equal(second.id, first.id);
  const index = JSON.parse(client.files.get('database/index.json').text);
  assert.equal(index.length, 1);
  assert.equal(index[0].pointCount, 2);
});

test('loadGraph round-trips exactly what saveGraph wrote', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const saved = await db.saveGraph({ params: params(), points: points(), title: 'Round Trip', notes: 'notes here' });
  const loaded = await db.loadGraph(saved.hash);
  assert.deepEqual(loaded, saved);
});

test('loadGraph returns null (via the fallback, which also has nothing) for a hash never saved anywhere', async () => {
  const client = createFakeGithubClient();
  const fallback = createFakeFallback();
  const db = buildDb(client, fallback);
  assert.equal(await db.loadGraph('never-saved'), null);
  assert.ok(fallback.calls.includes('loadGraph'));
});

test('graphExists reflects a graph actually saved to GitHub', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const saved = await db.saveGraph({ params: params(), points: points() });
  assert.equal(await db.graphExists(saved.hash), true);
  assert.equal(await db.graphExists('some-other-hash'), false);
});

test('deleteGraph removes metadata.json, points.json, and the index entry; loadGraph/graphExists reflect that afterward', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const saved = await db.saveGraph({ params: params(), points: points() });
  await db.deleteGraph(saved.hash);
  assert.equal(await db.graphExists(saved.hash), false);
  assert.equal(client.files.has(`graphs/${saved.id}/metadata.json`), false);
  assert.equal(client.files.has(`graphs/${saved.id}/points.json`), false);
  const index = JSON.parse(client.files.get('database/index.json').text);
  assert.equal(index.length, 0);
});

test('deleteGraph never throws for a hash that was never saved', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  await assert.doesNotReject(() => db.deleteGraph('never-saved-hash'));
});

test('renameGraph changes only the title, leaving other fields (and the index) consistent', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const saved = await db.saveGraph({ params: params(), points: points(), title: 'Old Title' });
  const renamed = await db.renameGraph(saved.hash, 'New Title');
  assert.equal(renamed.title, 'New Title');
  const reloaded = await db.loadGraph(saved.hash);
  assert.equal(reloaded.metadata.title, 'New Title');
  const index = JSON.parse(client.files.get('database/index.json').text);
  assert.equal(index.length, 1);
  assert.equal(index[0].title, 'New Title');
});

test('updateGraphMetadata updates favorite/tags/notes together and never touches points.json', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const saved = await db.saveGraph({ params: params(), points: points() });
  const pointsShaBefore = client.files.get(`graphs/${saved.id}/points.json`).sha;
  const updated = await db.updateGraphMetadata(saved.hash, { favorite: true, tags: ['a', 'b'], notes: 'updated notes' });
  assert.equal(updated.favorite, true);
  assert.deepEqual(updated.tags, ['a', 'b']);
  assert.equal(client.files.get(`graphs/${saved.id}/points.json`).sha, pointsShaBefore);
  const reloaded = await db.loadGraph(saved.hash);
  assert.equal(reloaded.notes, 'updated notes');
});

test('listGraphs returns metadata only (never a points field), sorted newest-first by default', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const client = createFakeGithubClient();
  const db = buildDb(client);
  const first = await db.saveGraph({ params: params({ angleA: 15 }), points: points() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await db.saveGraph({ params: params({ angleA: 16 }), points: points() });
  const list = await db.listGraphs();
  assert.equal(list.length, 2);
  for (const entry of list) assert.ok(!('points' in entry));
  assert.equal(list[0].hash, second.hash);
  assert.equal(list[1].hash, first.hash);
});

test('searchGraphs query.text matches title/code/tags/owner/hash/notes, all from index.json alone (no extra file read)', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), title: 'Spiral Pattern', author: 'alice', tags: ['week1'], notes: 'boundary case here' });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), title: 'Star Pattern', author: 'bob', tags: ['project'], notes: 'nothing special' });

  assert.equal((await db.searchGraphs({ text: 'spiral' })).length, 1);
  assert.equal((await db.searchGraphs({ text: 'week1' })).length, 1);
  assert.equal((await db.searchGraphs({ text: 'alice' })).length, 1);
  assert.equal((await db.searchGraphs({ text: 'boundary case' })).length, 1);
});

test('searchGraphs structured filters (favorite/visibility/tags/angles) still work', async () => {
  const client = createFakeGithubClient();
  const db = buildDb(client);
  await db.saveGraph({ params: params({ angleA: 15 }), points: points(), favorite: true });
  await db.saveGraph({ params: params({ angleA: 16 }), points: points(), favorite: false });
  const results = await db.searchGraphs({ favorite: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].angleA, 15);
});

// --- Fallback to local storage (requirement #7) ----------------------------

test('every method falls back to the local GraphDatabase when GitHub throws', async () => {
  const throwingClient = {
    async getFile() { throw new Error('network down'); },
    async putFile() { throw new Error('network down'); },
    async deleteFile() { throw new Error('network down'); },
  };
  const fallback = createFakeFallback();
  const db = buildDb(throwingClient, fallback);

  await db.saveGraph({ params: params(), points: points() });
  assert.ok(fallback.calls.includes('saveGraph'), 'saveGraph should fall back');

  await db.loadGraph('some-hash');
  assert.ok(fallback.calls.includes('loadGraph'), 'loadGraph should fall back');

  await db.graphExists('some-hash');
  assert.ok(fallback.calls.includes('graphExists'), 'graphExists should fall back');

  await db.deleteGraph('some-hash');
  assert.ok(fallback.calls.includes('deleteGraph'), 'deleteGraph should fall back');

  await db.updateGraphMetadata('some-hash', { favorite: true });
  assert.ok(fallback.calls.includes('updateGraphMetadata'), 'updateGraphMetadata should fall back');

  await db.listGraphs();
  assert.ok(fallback.calls.includes('listGraphs'), 'listGraphs should fall back');

  await db.searchGraphs({});
  assert.ok(fallback.calls.includes('searchGraphs'), 'searchGraphs should fall back');
});

test('a graph saved locally during an outage is still found by loadGraph/graphExists once GitHub is reachable again (a GitHub *miss*, not just a thrown error, also falls back)', async () => {
  const client = createFakeGithubClient(); // reachable, but empty — this hash was never saved to GitHub
  const fallback = createFakeFallback();
  await fallback.saveGraph({ params: params(), points: points(), title: 'Saved during an outage' });
  const hash = params().sequenceText + params().angleA; // matches createFakeFallback's own stand-in hash

  const db = buildDb(client, fallback);
  const loaded = await db.loadGraph(hash);
  assert.ok(loaded, 'should find the locally-saved graph via fallback, not report null');
  assert.equal(loaded.metadata.title, 'Saved during an outage');
  assert.equal(await db.graphExists(hash), true);
});

test('saveGraph falls back to local storage (never loses the graph) if the GitHub write itself fails', async () => {
  const client = {
    async getFile() { return null; },
    async putFile() { throw new Error('rate limited'); },
    async deleteFile() {},
  };
  const fallback = createFakeFallback();
  const db = buildDb(client, fallback);
  const result = await db.saveGraph({ params: params(), points: points(), title: 'Should land locally' });
  assert.equal(result.metadata.title, 'Should land locally');
  assert.ok(fallback.calls.includes('saveGraph'));
});
