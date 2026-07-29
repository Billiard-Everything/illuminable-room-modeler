import assert from 'node:assert/strict';
import test from 'node:test';
import { graphRowToModel } from '../server/models/graph.js';
import { geometryRowToModel } from '../server/models/geometry.js';

test('graphRowToModel maps snake_case DB columns to the camelCase Graph shape', () => {
  const row = {
    id: 'graph-1', hash: 'hash-abc', sequence_text: 'RRL',
    angle_a: 30, angle_b: 60, angle_step_input: '0.5', base_length: 100,
    algorithm_version: 1, owner_user_id: 'user-1', created_at: 'created', updated_at: 'updated',
  };
  assert.deepEqual(graphRowToModel(row), {
    id: 'graph-1', hash: 'hash-abc',
    params: { sequenceText: 'RRL', angleA: 30, angleB: 60, angleStepInput: '0.5', baseLength: 100 },
    algorithmVersion: 1, ownerUserId: 'user-1', createdAt: 'created', updatedAt: 'updated',
  });
});

test('graphRowToModel preserves a null owner_user_id (unowned graph)', () => {
  const row = {
    id: 'graph-1', hash: 'h', sequence_text: 'X', angle_a: 1, angle_b: 2, angle_step_input: '1',
    base_length: 90, algorithm_version: 1, owner_user_id: null, created_at: 'c', updated_at: 'u',
  };
  assert.equal(graphRowToModel(row).ownerUserId, null);
});

test('geometryRowToModel maps snake_case DB columns to the camelCase Geometry shape', () => {
  const row = {
    id: 'geo-1', graph_id: 'graph-1', points: [{ a: 1, b: 2 }], point_count: 1,
    status: 'exact', duration_ms: 42, created_at: 'created', updated_at: 'updated',
  };
  assert.deepEqual(geometryRowToModel(row), {
    id: 'geo-1', graphId: 'graph-1', points: [{ a: 1, b: 2 }], pointCount: 1,
    status: 'exact', durationMs: 42, createdAt: 'created', updatedAt: 'updated',
  });
});

test('geometryRowToModel preserves a null duration_ms', () => {
  const row = { id: 'geo-1', graph_id: 'graph-1', points: [], point_count: 0, status: 'preview', duration_ms: null, created_at: 'c', updated_at: 'u' };
  assert.equal(geometryRowToModel(row).durationMs, null);
});
