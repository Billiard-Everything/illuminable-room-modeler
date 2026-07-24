import assert from 'node:assert/strict';
import test from 'node:test';
import { findPointsNearScreenPosition } from '../src/anglePlot/multiSeriesHover.js';

// Identity-ish screen transforms (1 px per degree, no pan) keep the math in
// these tests easy to reason about; the function itself is transform-agnostic.
const toScreenX = (a) => a;
const toScreenY = (b) => b;

test('returns nothing when no point is within the hit radius', () => {
  const series = [{ id: 'g1', label: 'Graph 1', color: '#000', points: [{ a: 50, b: 50 }] }];
  const result = findPointsNearScreenPosition(series, toScreenX, toScreenY, 0, 0, 7);
  assert.deepEqual(result, []);
});

test('finds the single nearest point from one series', () => {
  const series = [{ id: 'g1', label: 'Graph 1', color: '#000', points: [{ a: 10, b: 10 }, { a: 30, b: 30 }] }];
  const result = findPointsNearScreenPosition(series, toScreenX, toScreenY, 10.5, 10.5, 7);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'g1');
  assert.equal(result[0].a, 10);
});

test('reports every series that has a point at the same overlapping spot, not just the nearest', () => {
  const series = [
    { id: 'g1', label: 'Graph 1', color: '#111', points: [{ a: 20, b: 20 }] },
    { id: 'g2', label: 'Graph 2', color: '#222', points: [{ a: 20, b: 20 }] },
    { id: 'g3', label: 'Graph 3', color: '#333', points: [{ a: 90, b: 90 }] },
  ];
  const result = findPointsNearScreenPosition(series, toScreenX, toScreenY, 20, 20, 7);
  const ids = result.map((r) => r.id).sort();
  assert.deepEqual(ids, ['g1', 'g2']);
});

test('partially overlapping regions only merge points that are actually close together', () => {
  const series = [
    { id: 'g1', label: 'Graph 1', color: '#111', points: [{ a: 20, b: 20 }] },
    { id: 'g2', label: 'Graph 2', color: '#222', points: [{ a: 20.5, b: 20 }] },
    { id: 'g3', label: 'Graph 3', color: '#333', points: [{ a: 60, b: 60 }] },
  ];
  const result = findPointsNearScreenPosition(series, toScreenX, toScreenY, 20, 20, 7, 3);
  const ids = result.map((r) => r.id).sort();
  assert.deepEqual(ids, ['g1', 'g2']);
});

test('the cursor-nearest series is always first in the returned list', () => {
  const series = [
    { id: 'far', label: 'Far', color: '#111', points: [{ a: 22, b: 20 }] },
    { id: 'near', label: 'Near', color: '#222', points: [{ a: 20, b: 20 }] },
  ];
  const result = findPointsNearScreenPosition(series, toScreenX, toScreenY, 20, 20, 7, 5);
  assert.equal(result[0].id, 'near');
});

test('never reports the same series twice even if it has two points near the hover spot', () => {
  const series = [
    { id: 'g1', label: 'Graph 1', color: '#111', points: [{ a: 20, b: 20 }, { a: 20.2, b: 20 }] },
  ];
  const result = findPointsNearScreenPosition(series, toScreenX, toScreenY, 20, 20, 7, 5);
  assert.equal(result.length, 1);
});

test('an empty series list produces no matches', () => {
  assert.deepEqual(findPointsNearScreenPosition([], toScreenX, toScreenY, 0, 0, 7), []);
});
