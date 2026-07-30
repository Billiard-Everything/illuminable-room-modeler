// RemoteGraphRepository: the browser's one gateway to the shared graph
// library's PostgreSQL backend — see server/api/app.js for the HTTP layer
// this calls, and server/repositories/graphRepository.js for the only
// module that ever actually touches SQL. This file executes no SQL and
// never will; it only ever calls `fetch` against server/api/**'s two
// routes.
//
// Every function here is failure-tolerant by design, never by accident:
// a network error, a timeout, a non-2xx response, or the API process not
// running at all are all treated identically — as "the shared library
// isn't available right now" — logged (dev-only) and resolved to a benign
// value (null for a lookup, silently for an upload) rather than thrown.
// This is what lets AnglePlotWindow.jsx satisfy "PostgreSQL unavailable
// must never break plotting": every call site here can call these
// functions exactly like a network call that might simply not pan out,
// with the existing adaptive/background-exact pipeline as the fallback —
// never a special "is the database up" branch of its own.
//
// A short, bounded timeout (not the browser's own default, which can hang
// for tens of seconds) is what keeps an unavailable/slow server from
// meaningfully delaying the instant-preview promise the rest of this
// feature already makes — see startSequenceJob's own comment on where
// this sits in the pipeline.

const DEFAULT_TIMEOUT_MS = 600;

// Browsing/searching the shared library (server/api/app.js's GET
// /api/graphs, /api/graphs/search) is a deliberate, user-initiated action —
// opening the Graph Library panel or typing a search — not something
// gating an in-progress render the way fetchRemoteExactGraph's 600ms is.
// It can afford to wait a little longer for a real response before giving
// up, without any of the "instant preview" pressure that timeout exists
// for.
const LIBRARY_TIMEOUT_MS = 5000;

// import.meta.env is Vite-injected and undefined under plain Node (e.g.
// this module's own tests) — optional-chained throughout, matching
// workspaceManager.js's own established fix for the same gotcha.
const apiBaseUrl = () => import.meta.env?.VITE_GRAPH_API_URL || 'http://localhost:8787';

const devLog = (...args) => { if (import.meta.env?.DEV) console.log(...args); };
const devWarn = (...args) => { if (import.meta.env?.DEV) console.warn(...args); };

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Looks up the exact geometry for `hash` in the shared PostgreSQL library.
 *
 * @param {string} hash - graphHasher.js's hashGraph output.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{points: Array, durationMs: number|null}|null>} null
 *   for "not found" *and* for any failure/timeout — callers never need to
 *   distinguish the two, since both mean "fall back to local computation."
 */
export const fetchRemoteExactGraph = async (hash, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/graphs/${encodeURIComponent(hash)}`, {}, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: PostgreSQL lookup returned ${res.status}, continuing without it`);
      return null;
    }
    const body = await res.json();
    if (!body.exists) return null;
    devLog(`Renderer: PostgreSQL has this exact graph (${body.geometry.points.length} points)`);
    return { points: body.geometry.points, durationMs: body.geometry.durationMs ?? null };
  } catch (err) {
    // Covers: connection refused (no API server running), DNS failure,
    // our own timeout abort, or a malformed response body — all the same
    // "not available right now" outcome from this function's contract.
    devWarn('Renderer: PostgreSQL lookup unavailable, continuing without it', err);
    return null;
  }
};

/**
 * Uploads a freshly-computed exact graph to the shared library, if it
 * isn't already stored there (the server does the existence check — see
 * graphRepository.js's uploadExactGraphIfMissing — so this is a single
 * round trip either way).
 *
 * @param {object} params - graphParamsFromSequence's shape (graph.js).
 * @param {number} algorithmVersion - graphHasher.js's GRAPH_HASH_ALGORITHM_VERSION.
 * @param {Array} points
 * @param {number|null} durationMs
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<void>} never rejects; failures are logged, not thrown.
 */
export const uploadRemoteExactGraph = async (params, algorithmVersion, points, durationMs, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/graphs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params, algorithmVersion, points, durationMs }),
    }, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: PostgreSQL upload returned ${res.status}, exact graph stays local-only for now`);
      return;
    }
    const body = await res.json();
    devLog(body.uploaded
      ? 'Renderer: Uploaded exact graph to the shared PostgreSQL library'
      : 'Renderer: Exact graph already in the shared PostgreSQL library, skipped upload');
  } catch (err) {
    devWarn('Renderer: PostgreSQL upload unavailable, exact graph stays local-only for now', err);
  }
};

/**
 * Browses or searches the shared graph library's metadata (never geometry
 * — see server/api/app.js's own route-table comment on why the
 * browse/search routes are metadata-only). Used by the Graph Library panel
 * (src/graphLibrary/**) — nothing in the rendering pipeline calls this.
 *
 * Routes to GET /api/graphs/search instead of GET /api/graphs the moment
 * any of `search`'s fields are present, mirroring server/api/app.js's own
 * route table; a caller never has to pick the route by hand.
 *
 * @param {object} [params]
 * @param {string} [params.sort] - one of GraphRepository's GRAPH_SORT values.
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @param {{onlyExactGraphs?: boolean, ownerUserId?: string, algorithmVersion?: number, createdAfter?: string, createdBefore?: string}} [params.filters]
 * @param {{hash?: string, code?: string, angleA?: number, angleB?: number, baseLength?: number}} [params.search]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{graphs: Array, error: boolean}>} `error: true` on any
 *   failure (never thrown) — kept distinct from an empty `graphs` array so
 *   the panel can tell "the library has nothing matching yet" apart from
 *   "couldn't reach the library right now."
 */
export const fetchGraphLibraryPage = async ({ sort, limit, offset, filters = {}, search = {} } = {}, { timeoutMs = LIBRARY_TIMEOUT_MS } = {}) => {
  const queryParams = new URLSearchParams();
  if (sort) queryParams.set('sort', sort);
  if (limit !== undefined) queryParams.set('limit', String(limit));
  if (offset !== undefined) queryParams.set('offset', String(offset));
  if (filters.onlyExactGraphs) queryParams.set('onlyExactGraphs', 'true');
  if (filters.ownerUserId) queryParams.set('ownerUserId', filters.ownerUserId);
  if (filters.algorithmVersion !== undefined && filters.algorithmVersion !== '') queryParams.set('algorithmVersion', String(filters.algorithmVersion));
  if (filters.createdAfter) queryParams.set('createdAfter', filters.createdAfter);
  if (filters.createdBefore) queryParams.set('createdBefore', filters.createdBefore);

  const hasSearch = search.hash || search.code
    || (search.angleA !== undefined && search.angleA !== '')
    || (search.angleB !== undefined && search.angleB !== '')
    || (search.baseLength !== undefined && search.baseLength !== '');
  if (hasSearch) {
    if (search.hash) queryParams.set('hash', search.hash);
    if (search.code) queryParams.set('code', search.code);
    if (search.angleA !== undefined && search.angleA !== '') queryParams.set('angleA', String(search.angleA));
    if (search.angleB !== undefined && search.angleB !== '') queryParams.set('angleB', String(search.angleB));
    if (search.baseLength !== undefined && search.baseLength !== '') queryParams.set('baseLength', String(search.baseLength));
  }

  const path = hasSearch ? '/api/graphs/search' : '/api/graphs';
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}${path}?${queryParams}`, {}, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: Graph Library browse/search returned ${res.status}`);
      return { graphs: [], error: true };
    }
    const body = await res.json();
    return { graphs: body.graphs ?? [], error: false };
  } catch (err) {
    devWarn('Renderer: Graph Library unavailable', err);
    return { graphs: [], error: true };
  }
};
