import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphCacheKey, createGraphCache, GRAPH_CACHE_ALGORITHM_VERSION, MAX_CACHE_ENTRIES } from '../src/anglePlot/graphCache.js';

const baseArgs = () => ({
  sequenceText: '3 1 7 2 6 2 8 2 4 2',
  angleA: 15,
  angleB: 50,
  angleStepInput: '0.1',
  baseLength: 10,
  viewBounds: { minA: 0, maxA: 90, minB: 0, maxB: 90 },
  viewportSize: { width: 640, height: 480 },
  excludePoint: undefined,
});

test('buildGraphCacheKey is deterministic for identical inputs', () => {
  const args = baseArgs();
  assert.equal(buildGraphCacheKey(args), buildGraphCacheKey({ ...args }));
});

test('buildGraphCacheKey changes when the sequence code changes', () => {
  const args = baseArgs();
  const a = buildGraphCacheKey(args);
  const b = buildGraphCacheKey({ ...args, sequenceText: '1 1 1 1' });
  assert.notEqual(a, b);
});

test('buildGraphCacheKey changes when Angle A or Angle B changes', () => {
  const args = baseArgs();
  const a = buildGraphCacheKey(args);
  assert.notEqual(a, buildGraphCacheKey({ ...args, angleA: 20 }));
  assert.notEqual(a, buildGraphCacheKey({ ...args, angleB: 60 }));
});

test('buildGraphCacheKey treats different Angle Step text as different, even if numerically equal', () => {
  // Mirrors parseAngleStep's own exact-decimal-digits behavior: "0.1" and
  // "0.10" carry a different scale/stepUnits representation.
  const args = baseArgs();
  const a = buildGraphCacheKey({ ...args, angleStepInput: '0.1' });
  const b = buildGraphCacheKey({ ...args, angleStepInput: '0.10' });
  assert.notEqual(a, b);
});

test('buildGraphCacheKey changes when baseLength changes', () => {
  const args = baseArgs();
  assert.notEqual(buildGraphCacheKey(args), buildGraphCacheKey({ ...args, baseLength: 20 }));
});

test('buildGraphCacheKey changes when the view (pan/zoom) changes', () => {
  const args = baseArgs();
  const a = buildGraphCacheKey(args);
  const differentBounds = buildGraphCacheKey({ ...args, viewBounds: { minA: 10, maxA: 20, minB: 10, maxB: 20 } });
  const differentViewport = buildGraphCacheKey({ ...args, viewportSize: { width: 800, height: 600 } });
  assert.notEqual(a, differentBounds);
  assert.notEqual(a, differentViewport);
});

test('buildGraphCacheKey changes when excludePoint changes (active-row exclusion)', () => {
  const args = baseArgs();
  const noExclude = buildGraphCacheKey(args);
  const excludeOne = buildGraphCacheKey({ ...args, excludePoint: { a: 15, b: 50 } });
  const excludeOther = buildGraphCacheKey({ ...args, excludePoint: { a: 20, b: 60 } });
  assert.notEqual(noExclude, excludeOne);
  assert.notEqual(excludeOne, excludeOther);
});

test('buildGraphCacheKey embeds the algorithm version', () => {
  const key = buildGraphCacheKey(baseArgs());
  assert.ok(key.includes(`alg${GRAPH_CACHE_ALGORITHM_VERSION}`));
});

test('GraphCache: miss returns undefined and has() reports false', () => {
  const cache = createGraphCache();
  assert.equal(cache.get('missing-key'), undefined);
  assert.equal(cache.has('missing-key'), false);
});

test('GraphCache: set then get returns the exact stored value', () => {
  const cache = createGraphCache();
  const value = { points: [{ a: 1, b: 2 }], renderInfo: { pointCount: 1 } };
  cache.set('k1', value);
  assert.equal(cache.has('k1'), true);
  assert.equal(cache.get('k1'), value);
});

test('GraphCache: clear empties the cache', () => {
  const cache = createGraphCache();
  cache.set('k1', { points: [] });
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.has('k1'), false);
});

test('GraphCache: evicts the least-recently-used entry once over the bound', () => {
  const cache = createGraphCache();
  for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
    cache.set(`k${i}`, { points: [], renderInfo: { i } });
  }
  assert.equal(cache.size, MAX_CACHE_ENTRIES);
  // One more insertion should evict the oldest (k0), not any arbitrary entry.
  cache.set('k-extra', { points: [] });
  assert.equal(cache.size, MAX_CACHE_ENTRIES);
  assert.equal(cache.has('k0'), false);
  assert.equal(cache.has('k1'), true);
  assert.equal(cache.has('k-extra'), true);
});

test('GraphCache: reading an entry refreshes its recency so it survives eviction longer', () => {
  const cache = createGraphCache();
  for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
    cache.set(`k${i}`, { points: [], renderInfo: { i } });
  }
  // Touch the oldest entry (k0) so it becomes the most-recently-used.
  cache.get('k0');
  // Now insert one more — without the touch, k0 would have been evicted;
  // k1 (the next-oldest, never touched) should be evicted instead.
  cache.set('k-extra', { points: [] });
  assert.equal(cache.has('k0'), true);
  assert.equal(cache.has('k1'), false);
});
