import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphRepository } from '../server/repositories/graphRepository.js';
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
