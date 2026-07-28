import assert from 'node:assert/strict';
import test from 'node:test';
import { graphParamsFromSequence, toGraph } from '../src/anglePlot/graph.js';
import { GRAPH_STATUS } from '../src/anglePlot/graphStatus.js';

const seq = { id: 'seq-1', sequenceText: 'RRL', angleA: 30, angleB: 60, angleStepInput: '0.1' };

test('graphParamsFromSequence extracts exactly the fields that define a graph\'s content identity', () => {
  const params = graphParamsFromSequence(seq, 90);
  assert.deepEqual(params, {
    sequenceText: 'RRL', angleA: 30, angleB: 60, angleStepInput: '0.1', baseLength: 90,
  });
});

test('graphParamsFromSequence never includes viewport or excludePoint fields', () => {
  const params = graphParamsFromSequence(seq, 90);
  assert.ok(!('viewBounds' in params));
  assert.ok(!('viewportSize' in params));
  assert.ok(!('excludePoint' in params));
});

test('toGraph projects id/hash/params/geometry/status/metadata from a sequence + result', () => {
  const result = {
    points: [{ a: 1, b: 2 }],
    renderInfo: { graphStatus: GRAPH_STATUS.EXACT, pointCount: 1, durationMs: 42, fromCache: false },
  };
  const graph = toGraph(seq, result, 'hash-abc', 90);
  assert.equal(graph.id, 'seq-1');
  assert.equal(graph.hash, 'hash-abc');
  assert.deepEqual(graph.params, graphParamsFromSequence(seq, 90));
  assert.deepEqual(graph.geometry.points, result.points);
  assert.equal(graph.geometry.renderInfo, result.renderInfo);
  assert.equal(graph.status, GRAPH_STATUS.EXACT);
  assert.equal(graph.metadata.pointCount, 1);
  assert.equal(graph.metadata.durationMs, 42);
  assert.equal(graph.metadata.fromCache, false);
});

test('toGraph defaults status to PREVIEW when the result has no renderInfo yet', () => {
  const graph = toGraph(seq, undefined, 'hash-abc', 90);
  assert.equal(graph.status, GRAPH_STATUS.PREVIEW);
  assert.deepEqual(graph.geometry.points, []);
  assert.equal(graph.geometry.renderInfo, null);
  assert.equal(graph.metadata.pointCount, 0);
  assert.equal(graph.metadata.durationMs, null);
  assert.equal(graph.metadata.fromCache, false);
});

test('toGraph falls back to points.length for metadata.pointCount when renderInfo omits it', () => {
  const result = { points: [1, 2, 3], renderInfo: null };
  const graph = toGraph(seq, result, 'hash-abc', 90);
  assert.equal(graph.metadata.pointCount, 3);
});
