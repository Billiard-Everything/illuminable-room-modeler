// GraphCache: Stage 1 of a reusable graph-caching architecture.
//
// The goal (see the staged plan below) is a cache that eventually scales to
// thousands of graphs, survives reloads, and can progressively refine its
// own results — but this file deliberately only builds the first, smallest
// correct piece of that: an in-memory cache of already-computed adaptive
// render results, keyed by everything that actually determines them, so
// replotting an unchanged configuration reuses the previous geometry
// instead of recomputing it. Everything else (persistence, LOD, background
// refinement) is a documented extension point, not implemented here.
//
// Staged plan
// -----------
// Stage 1 (this file): in-memory Map, deterministic string key, caches
//   GEOMETRY only (the same plain { points, renderInfo } shape the caller
//   already produces) — never a rendered image, so a later stage can
//   re-render cached geometry at a different scale/theme/DPI for free.
// Stage 2 (future, not implemented): screen-space progressive refinement.
//   The natural extension point is CacheEntry — add an optional `lod` /
//   `refinedFrom` field so a coarse cached entry can be shown immediately
//   while a finer one computes in the background, without ever discarding
//   the coarse result mid-refinement. GraphCache's get/set are already the
//   only two operations a refinement scheduler would need.
// Stage 3 (future, not implemented): persistent storage (IndexedDB, then a
//   backend database) behind this exact same get/set/has interface, so
//   callers never change when the backing store does. The interface is
//   kept intentionally tiny (get/set/has/clear) for exactly this reason —
//   swapping the synchronous Map body for an async IndexedDB/fetch-backed
//   implementation is a change entirely internal to this module. (Stage 1
//   itself stays synchronous, since nothing here needs to await yet.)
//
// What NOT to look for here (see the task's own non-goals): no IndexedDB,
// no backend calls, no worker threads, no background scheduling, no LOD
// selection logic, no new UI. Those are exactly what Stages 2/3 add.

import { hashGraph } from './graphHasher.js';

// Bumped whenever a change to the adaptive generator itself
// (visibleAnglePointGenerator.js) or the sampling policy it reads
// (renderSamplingPolicy.js) would make an old cached entry disagree with
// what a fresh computation now produces — e.g. a bug fix in
// findValidPointInCell, or a change to how stride is chosen. Baking this
// into the cache key means such a change invalidates every existing entry
// automatically, without needing to hunt down and clear a live cache by
// hand. Kept independent from graphHasher.js's own GRAPH_HASH_ALGORITHM_VERSION
// (which versions the *exact* brute-force algorithm instead): a change to
// one sampler has no bearing on whether the other's already-cached results
// are still correct, so tying them together would invalidate one
// algorithm's cache over a change to the other's.
export const GRAPH_CACHE_ALGORITHM_VERSION = 1;

// Upper bound on how many finished results this in-memory cache holds at
// once (Stage 1 has no persistence, so this is a plain memory bound, not a
// meaningful cap toward "thousands of graphs" — that scale is what Stage 3
// exists for). Each entry can hold up to MAX_VISIBLE_RENDER_POINTS points
// (renderSamplingPolicy.js), so this stays modest rather than unbounded.
export const MAX_CACHE_ENTRIES = 200;

/**
 * Deterministic cache key covering every input that can change the OUTPUT
 * geometry of generateVisibleAnglePoints for a given row. The graph's own
 * content identity (code/angles/step/length) is delegated entirely to
 * graphHasher.js's hashGraph — this function only adds the fields that are
 * specific to the *viewport-scoped adaptive* result, never part of a
 * graph's permanent identity:
 *   - the current view (bounds + viewport size): the adaptive renderer's
 *     stride and sampled cells are view-dependent by design (see
 *     calculateSamplingStride in renderSamplingPolicy.js), so two requests
 *     for the same code/angles at different zoom/pan are genuinely
 *     different computations, not a cache hit for each other
 *   - excludePoint: only ever set for the currently active row (see
 *     AnglePlotWindow.jsx), and changes which single point is filtered out
 *     of the result — omitting it from the key would let a cached result
 *     computed while one row was active get reused, wrongly, once a
 *     different row becomes active
 *   - GRAPH_CACHE_ALGORITHM_VERSION
 */
export const buildGraphCacheKey = ({
  sequenceText, angleA, angleB, angleStepInput, baseLength, viewBounds, viewportSize, excludePoint,
}) => {
  const num = (value) => Number(value).toString();
  const boundsKey = viewBounds
    ? `${num(viewBounds.minA)}:${num(viewBounds.maxA)}:${num(viewBounds.minB)}:${num(viewBounds.maxB)}`
    : 'no-bounds';
  const viewportKey = viewportSize ? `${num(viewportSize.width)}x${num(viewportSize.height)}` : '0x0';
  const excludeKey = excludePoint ? `excl(${num(excludePoint.a)},${num(excludePoint.b)})` : 'excl(none)';
  return [
    hashGraph({ sequenceText, angleA, angleB, angleStepInput, baseLength }),
    `previewAlg${GRAPH_CACHE_ALGORITHM_VERSION}`,
    `view(${boundsKey})`,
    `viewport(${viewportKey})`,
    excludeKey,
  ].join('|');
};

/**
 * A tiny, storage-agnostic cache of finished graph geometry. Stage 1 keeps
 * this as a plain in-memory Map with LRU eviction; the get/set/has/clear
 * surface is intentionally the entire interface so a future persistent
 * backend can implement the same shape (see the module comment above).
 */
class GraphCache {
  constructor() {
    // Map preserves insertion order, which this uses directly for LRU:
    // re-inserting a key on both read and write keeps the least-recently-
    // used entry at the front, ready to evict first.
    this._store = new Map();
  }

  get(key) {
    const entry = this._store.get(key);
    if (entry === undefined) return undefined;
    this._store.delete(key);
    this._store.set(key, entry);
    return entry;
  }

  has(key) {
    return this._store.has(key);
  }

  set(key, value) {
    this._store.delete(key);
    this._store.set(key, value);
    if (this._store.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
    }
  }

  clear() {
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }
}

// A fresh, independent cache instance — used by tests, and available if a
// future caller ever needs a scope narrower than the whole session (e.g. a
// future per-tab or per-document cache instead of one shared singleton).
export const createGraphCache = () => new GraphCache();

// Stage 1's actual cache: one shared, in-memory, session-lifetime instance,
// mirroring how the previous exact-mode cache this replaces was scoped —
// naturally cleared on every full page reload, which is exactly the
// boundary Stage 3's persistence work will remove.
export const graphCache = createGraphCache();
