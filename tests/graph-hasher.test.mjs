import assert from 'node:assert/strict';
import test from 'node:test';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../src/anglePlot/graphHasher.js';

const baseParams = () => ({
  sequenceText: '3 1 7 2 6 2 8 2 4 2', angleA: 15, angleB: 50, angleStepInput: '0.1', baseLength: 90,
});

test('the same inputs always produce the identical hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph(baseParams());
  assert.equal(a, b);
});

test('a different sequence code produces a different hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph({ ...baseParams(), sequenceText: '3 1 7 2 6 2 8 2 4 3' });
  assert.notEqual(a, b);
});

test('whitespace-only differences in the sequence code still produce a different hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph({ ...baseParams(), sequenceText: '3  1 7 2 6 2 8 2 4 2' });
  assert.notEqual(a, b, 'even a whitespace difference is a different candidate-parsing input');
});

test('a different Angle A produces a different hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph({ ...baseParams(), angleA: 16 });
  assert.notEqual(a, b);
});

test('a different Angle B produces a different hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph({ ...baseParams(), angleB: 51 });
  assert.notEqual(a, b);
});

test('a different Angle Step produces a different hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph({ ...baseParams(), angleStepInput: '0.2' });
  assert.notEqual(a, b);
});

test('"0.10" and "0.1" are different step representations and hash differently', () => {
  const a = hashGraph({ ...baseParams(), angleStepInput: '0.1' });
  const b = hashGraph({ ...baseParams(), angleStepInput: '0.10' });
  assert.notEqual(a, b);
});

test('a different base length produces a different hash', () => {
  const a = hashGraph(baseParams());
  const b = hashGraph({ ...baseParams(), baseLength: 100 });
  assert.notEqual(a, b);
});

test('a different algorithm version produces a different hash', () => {
  // hashGraph always uses the module's current GRAPH_HASH_ALGORITHM_VERSION
  // internally, so this is exercised by directly comparing against a hash
  // string built the same way but with a different version baked in —
  // proving the version is genuinely part of the hash, not just a constant
  // sitting unused beside it.
  const real = hashGraph(baseParams());
  assert.equal(real.startsWith(`alg${GRAPH_HASH_ALGORITHM_VERSION}|`), true);
  const differentVersionHash = real.replace(`alg${GRAPH_HASH_ALGORITHM_VERSION}|`, `alg${GRAPH_HASH_ALGORITHM_VERSION + 1}|`);
  assert.notEqual(real, differentVersionHash);
});

test('numeric and equivalent string angle values hash the same (angleA/angleB are not representation-sensitive like the step)', () => {
  const a = hashGraph({ ...baseParams(), angleA: 15 });
  const b = hashGraph({ ...baseParams(), angleA: '15' });
  assert.equal(a, b);
});

test('never depends on zoom, pan, viewport, color, selection, or any other UI/view state — the function does not even accept them', () => {
  const withExtraFields = hashGraph({
    ...baseParams(),
    viewBounds: { minA: 0, maxA: 90, minB: 0, maxB: 90 },
    viewportSize: { width: 999, height: 999 },
    excludePoint: { a: 1, b: 2 },
    color: '#ff0000',
    zoom: 42,
    pan: { x: 1, y: 2 },
  });
  const withoutExtraFields = hashGraph(baseParams());
  assert.equal(withExtraFields, withoutExtraFields, 'unrecognized fields (view/UI state) must have zero effect on the hash');
});

test('never depends on time or randomness — repeated calls across a delay still agree', async () => {
  const a = hashGraph(baseParams());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const b = hashGraph(baseParams());
  assert.equal(a, b);
});
