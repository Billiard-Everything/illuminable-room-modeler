import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphRepository, GRAPH_SORT } from '../server/repositories/graphRepository.js';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../src/anglePlot/graphHasher.js';

// A fake pool: records every query call and lets each test script exactly
// what rows come back, so the repository's own SQL-building/mapping logic
// is fully exercised without a real PostgreSQL connection anywhere.
const createFakePool = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows };
    },
  };
};

// A fake pool returning a different, pre-scripted response per call, in
// order — needed for methods like uploadExactGraphIfMissing that make
// several distinct queries (each expecting its own row shape back).
const createSequencedFakePool = (responses) => {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (text, queryParams) => {
      calls.push({ text, params: queryParams });
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    },
  };
};

const params = () => ({ sequenceText: '3 1 7 2 6 2 8 2 4 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 90 });

test('findByHash queries by hash and maps a found row to a Graph model', async () => {
  const row = {
    id: 'graph-1', hash: 'hash-abc', sequence_text: '3 1 7 2 6 2 8 2 4 2',
    angle_a: 15, angle_b: 50, angle_step_input: '0.1', base_length: 90,
    algorithm_version: 1, owner_user_id: null, created_at: 'x', updated_at: 'y',
  };
  const pool = createFakePool([row]);
  const repo = createGraphRepository(pool);

  const found = await repo.findByHash('hash-abc');

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /SELECT \* FROM graphs WHERE hash = \$1/);
  assert.deepEqual(pool.calls[0].params, ['hash-abc']);
  assert.deepEqual(found, {
    id: 'graph-1', hash: 'hash-abc',
    params: { sequenceText: '3 1 7 2 6 2 8 2 4 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 90 },
    algorithmVersion: 1, ownerUserId: null, createdAt: 'x', updatedAt: 'y',
  });
});

test('findByHash returns null when no row matches', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  assert.equal(await repo.findByHash('missing'), null);
});

test('upsertGraph computes the hash via graphHasher.hashGraph and passes it as the first param', async () => {
  const row = {
    id: 'graph-1', hash: hashGraph(params()), sequence_text: params().sequenceText,
    angle_a: 15, angle_b: 50, angle_step_input: '0.1', base_length: 90,
    algorithm_version: GRAPH_HASH_ALGORITHM_VERSION, owner_user_id: null, created_at: 'x', updated_at: 'y',
  };
  const pool = createFakePool([row]);
  const repo = createGraphRepository(pool);

  const result = await repo.upsertGraph({ params: params() });

  assert.match(pool.calls[0].text, /INSERT INTO graphs/);
  assert.match(pool.calls[0].text, /ON CONFLICT \(hash\) DO UPDATE/);
  assert.equal(pool.calls[0].params[0], hashGraph(params()), 'the hash param must be graphHasher.hashGraph\'s own output, not a separate computation');
  assert.equal(result.hash, hashGraph(params()));
});

test('upsertGraph defaults algorithmVersion to graphHasher\'s current GRAPH_HASH_ALGORITHM_VERSION', async () => {
  const pool = createFakePool([{
    id: 'g', hash: 'h', sequence_text: 's', angle_a: 1, angle_b: 2, angle_step_input: '0.1',
    base_length: 90, algorithm_version: GRAPH_HASH_ALGORITHM_VERSION, owner_user_id: null, created_at: 'x', updated_at: 'y',
  }]);
  const repo = createGraphRepository(pool);
  await repo.upsertGraph({ params: params() });
  const algorithmVersionParamIndex = 6; // hash, code, a, b, step, len, algorithm_version, owner
  assert.equal(pool.calls[0].params[algorithmVersionParamIndex], GRAPH_HASH_ALGORITHM_VERSION);
});

test('getGeometry queries by graph_id and maps a found row to a Geometry model', async () => {
  const row = {
    id: 'geo-1', graph_id: 'graph-1', points: [{ a: 1, b: 2 }], point_count: 1,
    status: 'exact', duration_ms: 123, created_at: 'x', updated_at: 'y',
  };
  const pool = createFakePool([row]);
  const repo = createGraphRepository(pool);

  const geometry = await repo.getGeometry('graph-1');

  assert.match(pool.calls[0].text, /SELECT \* FROM graph_geometry WHERE graph_id = \$1/);
  assert.deepEqual(pool.calls[0].params, ['graph-1']);
  assert.deepEqual(geometry, {
    id: 'geo-1', graphId: 'graph-1', points: [{ a: 1, b: 2 }], pointCount: 1,
    status: 'exact', durationMs: 123, createdAt: 'x', updatedAt: 'y',
  });
});

test('getGeometry returns null when no geometry has been computed yet', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  assert.equal(await repo.getGeometry('graph-1'), null);
});

test('saveGeometry serializes points as JSON and derives point_count from the array length', async () => {
  const points = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  const pool = createFakePool([{
    id: 'geo-1', graph_id: 'graph-1', points, point_count: 2, status: 'exact', duration_ms: 500, created_at: 'x', updated_at: 'y',
  }]);
  const repo = createGraphRepository(pool);

  await repo.saveGeometry('graph-1', { points, status: 'exact', durationMs: 500 });

  assert.match(pool.calls[0].text, /INSERT INTO graph_geometry/);
  assert.match(pool.calls[0].text, /ON CONFLICT \(graph_id\) DO UPDATE/);
  assert.deepEqual(pool.calls[0].params, ['graph-1', JSON.stringify(points), 2, 'exact', 500]);
});

test('createJob inserts a queued job with the given priority', async () => {
  const pool = createFakePool([{ id: 'job-1', graph_id: 'graph-1', status: 'queued', priority: 0 }]);
  const repo = createGraphRepository(pool);

  const job = await repo.createJob({ graphId: 'graph-1', priority: 0 });

  assert.match(pool.calls[0].text, /INSERT INTO graph_jobs/);
  assert.match(pool.calls[0].text, /'queued'/);
  assert.deepEqual(pool.calls[0].params, ['graph-1', 0]);
  assert.equal(job.status, 'queued');
});

test('updateJobStatus updates status and only overwrites started_at/finished_at when provided', async () => {
  const pool = createFakePool([{ id: 'job-1', status: 'running' }]);
  const repo = createGraphRepository(pool);

  await repo.updateJobStatus('job-1', { status: 'running' });

  assert.match(pool.calls[0].text, /UPDATE graph_jobs SET/);
  assert.match(pool.calls[0].text, /COALESCE\(\$3, started_at\)/);
  assert.deepEqual(pool.calls[0].params, ['job-1', 'running', null, null, null]);
});

test('updateJobStatus returns null if no job matched the id', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  assert.equal(await repo.updateJobStatus('missing', { status: 'failed' }), null);
});

// --- graphExists / getGraphWithGeometry / uploadExactGraphIfMissing -------

test('graphExists returns true when a row is found, false otherwise', async () => {
  const existsPool = createFakePool([{ '?column?': 1 }]);
  assert.equal(await createGraphRepository(existsPool).graphExists('hash-abc'), true);
  assert.match(existsPool.calls[0].text, /SELECT 1 FROM graphs WHERE hash = \$1/);
  assert.deepEqual(existsPool.calls[0].params, ['hash-abc']);

  const missingPool = createFakePool([]);
  assert.equal(await createGraphRepository(missingPool).graphExists('hash-abc'), false);
});

test('getGraphWithGeometry joins graphs and graph_geometry and maps both models from one row', async () => {
  const row = {
    id: 'graph-1', hash: 'hash-abc', sequence_text: '3 1 7 2 6 2 8 2 4 2',
    angle_a: 15, angle_b: 50, angle_step_input: '0.1', base_length: 90,
    algorithm_version: 1, owner_user_id: null, created_at: 'g-created', updated_at: 'g-updated',
    geometry_id: 'geo-1', points: [{ a: 1, b: 2 }], point_count: 1, geometry_status: 'exact',
    duration_ms: 999, geometry_created_at: 'geo-created', geometry_updated_at: 'geo-updated',
  };
  const pool = createFakePool([row]);
  const repo = createGraphRepository(pool);

  const result = await repo.getGraphWithGeometry('hash-abc');

  assert.match(pool.calls[0].text, /JOIN graph_geometry/);
  assert.deepEqual(pool.calls[0].params, ['hash-abc']);
  assert.deepEqual(result.graph, {
    id: 'graph-1', hash: 'hash-abc',
    params: { sequenceText: '3 1 7 2 6 2 8 2 4 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 90 },
    algorithmVersion: 1, ownerUserId: null, createdAt: 'g-created', updatedAt: 'g-updated',
  });
  assert.deepEqual(result.geometry, {
    id: 'geo-1', graphId: 'graph-1', points: [{ a: 1, b: 2 }], pointCount: 1,
    status: 'exact', durationMs: 999, createdAt: 'geo-created', updatedAt: 'geo-updated',
  });
});

test('getGraphWithGeometry returns null when the hash has never been stored', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  assert.equal(await repo.getGraphWithGeometry('missing-hash'), null);
});

test('uploadExactGraphIfMissing checks graphExists first and skips the insert when the hash is already stored', async () => {
  const pool = createFakePool([{ '?column?': 1 }]); // graphExists -> true
  const repo = createGraphRepository(pool);

  const result = await repo.uploadExactGraphIfMissing({ params: params(), points: [{ a: 1, b: 2 }], durationMs: 100 });

  assert.deepEqual(result, { uploaded: false });
  assert.equal(pool.calls.length, 1, 'must never insert anything once graphExists says it is already stored');
  assert.match(pool.calls[0].text, /SELECT 1 FROM graphs/);
});

test('uploadExactGraphIfMissing saves graph metadata and geometry together when the hash is new', async () => {
  const graphRow = {
    id: 'graph-1', hash: hashGraph(params()), sequence_text: params().sequenceText,
    angle_a: 15, angle_b: 50, angle_step_input: '0.1', base_length: 90,
    algorithm_version: GRAPH_HASH_ALGORITHM_VERSION, owner_user_id: null, created_at: 'x', updated_at: 'y',
  };
  const geometryRow = {
    id: 'geo-1', graph_id: 'graph-1', points: [{ a: 1, b: 2 }], point_count: 1, status: 'exact', duration_ms: 100, created_at: 'x', updated_at: 'y',
  };
  // Call order: graphExists (empty -> false), upsertGraph (-> graphRow), saveGeometry (-> geometryRow).
  const pool = createSequencedFakePool([{ rows: [] }, { rows: [graphRow] }, { rows: [geometryRow] }]);
  const repo = createGraphRepository(pool);

  const result = await repo.uploadExactGraphIfMissing({ params: params(), points: [{ a: 1, b: 2 }], durationMs: 100 });

  assert.equal(result.uploaded, true);
  assert.equal(result.graph.hash, hashGraph(params()));
  assert.equal(result.geometry.pointCount, 1);
  assert.equal(pool.calls.length, 3);
  assert.match(pool.calls[0].text, /SELECT 1 FROM graphs/);
  assert.match(pool.calls[1].text, /INSERT INTO graphs/);
  assert.match(pool.calls[2].text, /INSERT INTO graph_geometry/);
});

test('uploadExactGraphIfMissing computes the hash via graphHasher, never independently', async () => {
  const pool = createFakePool([{ '?column?': 1 }]);
  const repo = createGraphRepository(pool);
  await repo.uploadExactGraphIfMissing({ params: params(), points: [], durationMs: null });
  assert.equal(pool.calls[0].params[0], hashGraph(params()));
});

// --- Shared graph library: browse, search, sort, filter (Phase 6) --------

const metadataRow = (overrides = {}) => ({
  hash: 'hash-abc', sequence_text: '3 1 7 2 6 2 8 2 4 2', angle_a: 15, angle_b: 50,
  angle_step_input: '0.1', base_length: 90, algorithm_version: 1, owner_user_id: null,
  created_at: 'created', updated_at: 'updated', download_count: 0, last_accessed_at: null,
  point_count: 59, geometry_updated_at: 'geo-updated', has_exact_geometry: true,
  ...overrides,
});

test('listGraphs queries with a LEFT JOIN, defaults to newest-first, and maps rows to metadata only (no points)', async () => {
  const pool = createFakePool([metadataRow()]);
  const repo = createGraphRepository(pool);

  const results = await repo.listGraphs();

  assert.match(pool.calls[0].text, /LEFT JOIN graph_geometry/);
  assert.match(pool.calls[0].text, /ORDER BY g\.created_at DESC/);
  assert.equal(results.length, 1);
  assert.equal(results[0].hash, 'hash-abc');
  assert.equal(results[0].pointCount, 59);
  assert.equal(results[0].hasExactGeometry, true);
  assert.ok(!('points' in results[0]), 'browsing must never include geometry points');
});

test('listGraphs defaults limit/offset and applies them as the final two positional params', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs();
  const params_ = pool.calls[0].params;
  assert.deepEqual(params_.slice(-2), [50, 0]);
});

test('listGraphs clamps an oversized limit to MAX_LIST_LIMIT (200)', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ limit: 100000 });
  const params_ = pool.calls[0].params;
  assert.equal(params_.at(-2), 200);
});

test('listGraphs clamps a negative offset to 0', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ offset: -5 });
  assert.equal(pool.calls[0].params.at(-1), 0);
});

test('listGraphs respects a custom limit/offset within bounds', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ limit: 10, offset: 20 });
  assert.deepEqual(pool.calls[0].params.slice(-2), [10, 20]);
});

for (const [sort, expectedOrderBy] of [
  [GRAPH_SORT.NEWEST, 'g.created_at DESC'],
  [GRAPH_SORT.OLDEST, 'g.created_at ASC'],
  [GRAPH_SORT.RECENTLY_COMPUTED, 'gg.updated_at DESC NULLS LAST'],
  [GRAPH_SORT.RECENTLY_USED, 'g.last_accessed_at DESC NULLS LAST'],
  [GRAPH_SORT.MOST_DOWNLOADED, 'g.download_count DESC'],
]) {
  test(`listGraphs({ sort: '${sort}' }) orders by ${expectedOrderBy}`, async () => {
    const pool = createFakePool([]);
    const repo = createGraphRepository(pool);
    await repo.listGraphs({ sort });
    assert.ok(pool.calls[0].text.includes(`ORDER BY ${expectedOrderBy}`));
  });
}

test('an unrecognized sort value falls back to newest-first rather than erroring', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ sort: 'not-a-real-sort' });
  assert.ok(pool.calls[0].text.includes('ORDER BY g.created_at DESC'));
});

test('listGraphs filters by hash as a partial (ILIKE) match', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ filters: { hash: 'alg1|code' } });
  assert.match(pool.calls[0].text, /g\.hash ILIKE/);
  assert.equal(pool.calls[0].params[0], '%alg1|code%');
});

test('listGraphs filters by sequenceText as a partial (ILIKE) match', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ filters: { sequenceText: '3 1 7' } });
  assert.match(pool.calls[0].text, /g\.sequence_text ILIKE/);
  assert.equal(pool.calls[0].params[0], '%3 1 7%');
});

test('listGraphs filters by angleA/angleB/baseLength as exact matches', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ filters: { angleA: 15, angleB: 50, baseLength: 90 } });
  assert.match(pool.calls[0].text, /g\.angle_a = \$1/);
  assert.match(pool.calls[0].text, /g\.angle_b = \$2/);
  assert.match(pool.calls[0].text, /g\.base_length = \$3/);
  assert.deepEqual(pool.calls[0].params.slice(0, 3), [15, 50, 90]);
});

test('listGraphs filters by ownerUserId and algorithmVersion as exact matches', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ filters: { ownerUserId: 'user-1', algorithmVersion: 1 } });
  assert.match(pool.calls[0].text, /g\.owner_user_id = \$1/);
  assert.match(pool.calls[0].text, /g\.algorithm_version = \$2/);
  assert.deepEqual(pool.calls[0].params.slice(0, 2), ['user-1', 1]);
});

test('listGraphs filters by a createdAfter/createdBefore date range', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ filters: { createdAfter: '2026-01-01', createdBefore: '2026-02-01' } });
  assert.match(pool.calls[0].text, /g\.created_at >= \$1/);
  assert.match(pool.calls[0].text, /g\.created_at <= \$2/);
  assert.deepEqual(pool.calls[0].params.slice(0, 2), ['2026-01-01', '2026-02-01']);
});

test('listGraphs filters by onlyExactGraphs without adding a bind parameter', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs({ filters: { onlyExactGraphs: true } });
  assert.match(pool.calls[0].text, /gg\.id IS NOT NULL/);
  // Only limit/offset should be bound — no extra param for this filter.
  assert.equal(pool.calls[0].params.length, 2);
});

test('listGraphs with no filters adds no WHERE clause at all', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphs();
  assert.ok(!pool.calls[0].text.includes('WHERE'));
});

test('searchGraphs merges the search query into filters alongside any additional options filters', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.searchGraphs({ hash: 'abc', angleA: 15 }, { filters: { onlyExactGraphs: true }, sort: GRAPH_SORT.OLDEST });
  assert.match(pool.calls[0].text, /g\.hash ILIKE/);
  assert.match(pool.calls[0].text, /g\.angle_a = /);
  assert.match(pool.calls[0].text, /gg\.id IS NOT NULL/);
  assert.match(pool.calls[0].text, /ORDER BY g\.created_at ASC/);
});

test('listGraphsByUser filters by the given ownerUserId', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listGraphsByUser('user-42');
  assert.match(pool.calls[0].text, /g\.owner_user_id = \$1/);
  assert.equal(pool.calls[0].params[0], 'user-42');
});

test('listRecentGraphs defaults to newest-first', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listRecentGraphs();
  assert.match(pool.calls[0].text, /ORDER BY g\.created_at DESC/);
});

test('listRecentGraphs honors an explicit sort override', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listRecentGraphs({ sort: GRAPH_SORT.OLDEST });
  assert.match(pool.calls[0].text, /ORDER BY g\.created_at ASC/);
});

test('listPopularGraphs defaults to most-downloaded-first', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.listPopularGraphs();
  assert.match(pool.calls[0].text, /ORDER BY g\.download_count DESC/);
});

test('getGraphMetadata looks up an exact hash (not a substring/ILIKE match)', async () => {
  const pool = createFakePool([metadataRow({ hash: 'hash-abc' })]);
  const repo = createGraphRepository(pool);
  const result = await repo.getGraphMetadata('hash-abc');
  assert.match(pool.calls[0].text, /g\.hash = \$1/);
  assert.ok(!pool.calls[0].text.includes('ILIKE'), 'an exact single-graph lookup must never use a substring match');
  assert.equal(pool.calls[0].params[0], 'hash-abc');
  assert.equal(result.hash, 'hash-abc');
  assert.ok(!('points' in result));
});

test('getGraphMetadata returns null when the hash has never been stored', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  assert.equal(await repo.getGraphMetadata('missing'), null);
});

test('recordGraphAccess increments download_count and stamps last_accessed_at for the given hash', async () => {
  const pool = createFakePool([]);
  const repo = createGraphRepository(pool);
  await repo.recordGraphAccess('hash-abc');
  assert.match(pool.calls[0].text, /UPDATE graphs SET download_count = download_count \+ 1/);
  assert.match(pool.calls[0].text, /last_accessed_at = now\(\)/);
  assert.deepEqual(pool.calls[0].params, ['hash-abc']);
});
