import assert from 'node:assert/strict';
import test from 'node:test';
import { primeExactGraphCache } from '../src/anglePlot/exactGraphCaching.js';
import { graphCache } from '../src/anglePlot/graphCache.js';
import { GRAPH_STATUS } from '../src/anglePlot/graphStatus.js';
import { RENDERER_MODE } from '../src/anglePlot/rendererSelection.js';

test.beforeEach(() => graphCache.clear());

test('primeExactGraphCache writes { points, renderInfo } into GraphCache under the given hash', () => {
  const points = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  primeExactGraphCache('hash-abc', '0.1', { points, durationMs: 500 });

  const cached = graphCache.get('hash-abc');
  assert.ok(cached);
  assert.deepEqual(cached.points, points);
});

test('primeExactGraphCache builds renderInfo tagged EXACT / brute-force', () => {
  const points = [{ a: 1, b: 2 }];
  primeExactGraphCache('hash-abc', '0.1', { points, durationMs: 500 });
  const { renderInfo } = graphCache.get('hash-abc');
  assert.equal(renderInfo.graphStatus, GRAPH_STATUS.EXACT);
  assert.equal(renderInfo.renderer, RENDERER_MODE.BRUTE_FORCE);
  assert.equal(renderInfo.budgetLimited, false);
  assert.equal(renderInfo.timeLimited, false);
});

test('primeExactGraphCache sets pointCount from the geometry points length', () => {
  const points = [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }];
  primeExactGraphCache('hash-abc', '0.1', { points, durationMs: null });
  assert.equal(graphCache.get('hash-abc').renderInfo.pointCount, 3);
});

test('primeExactGraphCache carries durationMs through from the geometry result, or null if absent', () => {
  primeExactGraphCache('hash-a', '0.1', { points: [], durationMs: 250 });
  assert.equal(graphCache.get('hash-a').renderInfo.durationMs, 250);

  primeExactGraphCache('hash-b', '0.1', { points: [] });
  assert.equal(graphCache.get('hash-b').renderInfo.durationMs, null);
});

test('primeExactGraphCache derives userStepDegrees/gridStepDegrees/requestedStepDegrees from the given Angle Step', () => {
  primeExactGraphCache('hash-abc', '0.5', { points: [], durationMs: null });
  const { renderInfo } = graphCache.get('hash-abc');
  assert.equal(renderInfo.userStepDegrees, 0.5);
  assert.equal(renderInfo.gridStepDegrees, 0.5);
  assert.equal(renderInfo.requestedStepDegrees, 0.5);
});

test('primeExactGraphCache returns the same renderInfo object it cached', () => {
  const points = [{ a: 1, b: 2 }];
  const renderInfo = primeExactGraphCache('hash-abc', '0.1', { points, durationMs: 10 });
  assert.deepEqual(renderInfo, graphCache.get('hash-abc').renderInfo);
});

test('primeExactGraphCache falls back gracefully for an invalid Angle Step rather than throwing', () => {
  assert.doesNotThrow(() => primeExactGraphCache('hash-abc', 'not-a-number', { points: [], durationMs: null }));
  const { renderInfo } = graphCache.get('hash-abc');
  assert.equal(renderInfo.userStepDegrees, null);
});

test('two different hashes never collide in GraphCache', () => {
  primeExactGraphCache('hash-a', '0.1', { points: [{ a: 1, b: 2 }], durationMs: null });
  primeExactGraphCache('hash-b', '0.2', { points: [{ a: 3, b: 4 }], durationMs: null });
  assert.deepEqual(graphCache.get('hash-a').points, [{ a: 1, b: 2 }]);
  assert.deepEqual(graphCache.get('hash-b').points, [{ a: 3, b: 4 }]);
});
