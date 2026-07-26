// In-memory, session-only cache for exact-mode "Valid Angle A-B Region"
// sweeps. No database, no localStorage — this is a plain Map living at
// module scope, so it survives closing/reopening the plot window (a fresh
// component mount) but is cleared on a real page reload, exactly matching
// "for the current browser session" from the task. Adaptive-mode results
// are deliberately NOT cached here: they depend on the current viewport
// (zoom/pan), which is not one of the fixed calculation inputs below, so a
// cached adaptive result could not be validly reused for a different view.
//
// Bump ALGORITHM_VERSION whenever unfoldCodeData/buildPoolshotTowerValidation
// or the sweep itself changes in a way that could change results for the
// same inputs — this invalidates every previously-cached entry for free
// (old keys simply never match a newly-built key again) without needing to
// walk and evict the cache by hand.
export const ALGORITHM_VERSION = 'exact-sweep-v1';

// Bounded so a long session plotting many distinct graphs can't grow this
// without limit; least-recently-used entries are evicted first. Each entry
// holds a full points array (up to MAX_ANGLE_GRID_ITERATIONS-bounded, but
// still potentially tens of thousands of points), so the bound is sized
// modestly rather than assuming entries are cheap.
const MAX_CACHE_ENTRIES = 40;

// Map iteration order follows insertion order, and a re-inserted key moves
// to the end — that's exactly LRU recency with no extra bookkeeping.
const cache = new Map();

// Normalizes a numeric input so equivalent values (15 vs "15.0" vs 15.00)
// always produce the same cache key. Non-numeric/blank values fall back to
// their raw string form so an incomplete input still yields a stable (if
// cache-missing) key rather than throwing.
const normalizeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value ?? '');
};

/**
 * Builds the cache key from every calculation-relevant input. `regionSettings`
 * is optional (this project's current algorithm doesn't have any beyond
 * what's already listed, but the slot exists so a future viewport-independent
 * region setting can be folded in without changing every call site).
 */
export const buildAngleRegionCacheKey = ({ sequenceText, angleA, angleB, angleStepInput, baseLength, regionSettings }) => {
  const normalizedSequence = (sequenceText || '').trim().replace(/\s+/g, ' ');
  return [
    ALGORITHM_VERSION,
    normalizedSequence,
    normalizeNumber(angleA),
    normalizeNumber(angleB),
    normalizeNumber(angleStepInput),
    normalizeNumber(baseLength),
    regionSettings ? JSON.stringify(regionSettings) : '',
  ].join('|');
};

export const getCachedAngleRegion = (key) => {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  // Refresh recency: delete + re-set moves this key to the end of Map's
  // iteration order, which is what the eviction loop below treats as "most
  // recently used".
  cache.delete(key);
  cache.set(key, value);
  return value;
};

export const setCachedAngleRegion = (key, value) => {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
};

// Exposed for tests/dev tooling only — not used by the app itself, since
// invalidation is handled by ALGORITHM_VERSION and LRU eviction.
export const clearAngleRegionCache = () => cache.clear();
export const angleRegionCacheSize = () => cache.size;
