// LocalGraphDatabaseClient: the browser's gateway to the file-based
// GraphDatabase (server/graphDatabase/graphDatabase.js) via server/api/
// app.js's /api/local-graphs routes — the browser can never touch the
// server's filesystem directly, so this is the same "thin HTTP layer in
// front of server-side storage" pattern remoteGraphRepository.js already
// established for the PostgreSQL-backed shared library, just pointed at a
// different backing store on the same api process.
//
// Same never-throw contract as remoteGraphRepository.js: a network error,
// timeout, or non-2xx response all resolve to "not available right now"
// (null for a lookup, silently for a save) rather than throwing — so every
// call site here can treat this exactly like an optional, best-effort
// cache lookup, with the existing adaptive/background-exact pipeline as
// the fallback.

import { apiBaseUrl, devLog, devWarn, fetchWithTimeout } from './apiClientUtils.js';

const DEFAULT_TIMEOUT_MS = 600;
// The Graph Database browser's own actions (browse/search/rename/favorite/
// tags/notes/delete) are deliberate, user-initiated clicks — not something
// gating an in-progress render the way fetchLocalExactGraph/
// saveLocalExactGraph's 600ms is (see remoteGraphRepository.js's own
// LIBRARY_TIMEOUT_MS for the identical reasoning on the PostgreSQL side).
const BROWSER_TIMEOUT_MS = 5000;

/**
 * Looks up the exact geometry for `hash` in the local file-based GraphDatabase.
 *
 * @param {string} hash - graphHasher.js's hashGraph output.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{points: Array, durationMs: number|null}|null>} null
 *   for "not found" *and* for any failure/timeout — callers never need to
 *   distinguish the two, since both mean "fall back to local computation."
 */
export const fetchLocalExactGraph = async (hash, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/local-graphs/${encodeURIComponent(hash)}`, {}, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: local GraphDatabase lookup returned ${res.status}, continuing without it`);
      return null;
    }
    const body = await res.json();
    if (!body.exists) return null;
    devLog(`Renderer: local GraphDatabase has this exact graph (${body.graph.points.length} points)`);
    return { points: body.graph.points, durationMs: body.graph.metadata?.computeTimeMs ?? null };
  } catch (err) {
    // Covers: connection refused (no API server running), DNS failure, our
    // own timeout abort, or a malformed response body — all the same "not
    // available right now" outcome from this function's contract.
    devWarn('Renderer: local GraphDatabase lookup unavailable, continuing without it', err);
    return null;
  }
};

/**
 * Saves a freshly-computed exact graph to the local file-based
 * GraphDatabase (always an upsert — see graphDatabase.js's saveGraph).
 *
 * @param {object} params - graphParamsFromSequence's shape (graph.js).
 * @param {number} algorithmVersion - graphHasher.js's GRAPH_HASH_ALGORITHM_VERSION (unused server-side; graphDatabase.js derives its own from the same constant — kept for signature parity with uploadRemoteExactGraph).
 * @param {Array} points
 * @param {number|null} durationMs
 * @param {{timeoutMs?: number, title?: string, graphColorHex?: string, notes?: string, tags?: string[], favorite?: boolean, visibility?: string}} [options] -
 *   the row's own richer metadata (sequenceGraphConfig.js's createSequenceRow),
 *   threaded straight through to graphDatabase.js's saveGraph — see that
 *   module's own buildMetadata for how each is preserved/defaulted server-side.
 * @returns {Promise<void>} never rejects; failures are logged, not thrown.
 */
export const saveLocalExactGraph = async (params, algorithmVersion, points, durationMs, {
  timeoutMs = DEFAULT_TIMEOUT_MS, title, graphColorHex, notes, tags, favorite, visibility,
} = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/local-graphs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params, points, computeTimeMs: durationMs, title, graphColorHex, notes, tags, favorite, visibility }),
    }, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: local GraphDatabase save returned ${res.status}, exact graph stays uncached locally for now`);
      return;
    }
    devLog('Renderer: Saved exact graph to the local file-based GraphDatabase');
  } catch (err) {
    devWarn('Renderer: local GraphDatabase save unavailable, exact graph stays uncached locally for now', err);
  }
};

/**
 * Fetches a graph's full stored record — points AND notes together (unlike
 * fetchLocalExactGraph, which only ever returns {points, durationMs} for
 * the render pipeline's own cache-hit path and was left untouched here to
 * avoid coupling that established contract to this browser-only need).
 * Used by the Graph Database browser the moment a card is selected: one
 * request gets both the notes text to show/edit AND the geometry, so a
 * subsequent "Load Graph" click never needs a second round trip.
 *
 * @param {string} hash
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{points: Array, durationMs: number|null, notes: string}|null>}
 *   null for "not found" *and* for any failure/timeout, same as fetchLocalExactGraph.
 */
export const fetchLocalGraphDetails = async (hash, { timeoutMs = BROWSER_TIMEOUT_MS } = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/local-graphs/${encodeURIComponent(hash)}`, {}, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: Graph Database detail lookup returned ${res.status}`);
      return null;
    }
    const body = await res.json();
    if (!body.exists) return null;
    return { points: body.graph.points, durationMs: body.graph.metadata?.computeTimeMs ?? null, notes: body.graph.notes ?? '' };
  } catch (err) {
    devWarn('Renderer: Graph Database detail lookup unavailable', err);
    return null;
  }
};

/**
 * Browses or searches the local GraphDatabase's metadata (never geometry —
 * mirrors remoteGraphRepository.js's fetchGraphLibraryPage and
 * server/api/app.js's own route-table comment on why the browse/search
 * routes are metadata-only). Used by the Graph Database browser
 * (src/graphLibrary/**) — nothing in the rendering pipeline calls this.
 *
 * Routes to GET /api/local-graphs/search instead of GET /api/local-graphs
 * the moment any of `search`'s fields are present, mirroring
 * fetchGraphLibraryPage's own identical convention.
 *
 * @param {object} [params]
 * @param {string} [params.sort] - one of localGraphDatabaseConstants.js's LOCAL_GRAPH_SORT values.
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @param {{text?: string, title?: string, code?: string, angleA?: number, angleB?: number, baseLength?: number, favorite?: boolean, visibility?: string, tags?: string[]}} [params.search] -
 *   `text` is the browser's one free-text search box — matches across
 *   title/code/tags/notes/owner/hash server-side (see graphDatabase.js's
 *   own searchGraphs comment); every other field is an exact/structured
 *   filter, ANDed with `text` when both are present.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{graphs: Array, error: boolean}>} `error: true` on any
 *   failure (never thrown) — kept distinct from an empty `graphs` array so
 *   the panel can tell "the library has nothing matching yet" apart from
 *   "couldn't reach it right now."
 */
export const fetchLocalGraphLibraryPage = async ({ sort, limit, offset, search = {} } = {}, { timeoutMs = BROWSER_TIMEOUT_MS } = {}) => {
  const queryParams = new URLSearchParams();
  if (sort) queryParams.set('sort', sort);
  if (limit !== undefined) queryParams.set('limit', String(limit));
  if (offset !== undefined) queryParams.set('offset', String(offset));

  const hasSearch = search.text || search.title || search.code
    || (search.angleA !== undefined && search.angleA !== '')
    || (search.angleB !== undefined && search.angleB !== '')
    || (search.baseLength !== undefined && search.baseLength !== '')
    || search.favorite || search.visibility || (search.tags && search.tags.length > 0);
  if (hasSearch) {
    if (search.text) queryParams.set('q', search.text);
    if (search.title) queryParams.set('title', search.title);
    if (search.code) queryParams.set('code', search.code);
    if (search.angleA !== undefined && search.angleA !== '') queryParams.set('angleA', String(search.angleA));
    if (search.angleB !== undefined && search.angleB !== '') queryParams.set('angleB', String(search.angleB));
    if (search.baseLength !== undefined && search.baseLength !== '') queryParams.set('baseLength', String(search.baseLength));
    if (search.favorite) queryParams.set('favorite', 'true');
    if (search.visibility) queryParams.set('visibility', search.visibility);
    if (search.tags && search.tags.length > 0) queryParams.set('tags', search.tags.join(','));
  }

  const path = hasSearch ? '/api/local-graphs/search' : '/api/local-graphs';
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}${path}?${queryParams}`, {}, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: Graph Database browse/search returned ${res.status}`);
      return { graphs: [], error: true };
    }
    const body = await res.json();
    return { graphs: body.graphs ?? [], error: false };
  } catch (err) {
    devWarn('Renderer: Graph Database unavailable', err);
    return { graphs: [], error: true };
  }
};

/**
 * Partial-updates a graph's metadata (rename, favorite, tags, notes,
 * visibility, color) — an explicit, user-initiated librarian action (the
 * Graph Database browser's rename/favorite-toggle/tag-edit/notes-edit
 * controls), so unlike fetchLocalExactGraph/saveLocalExactGraph this
 * reports success/failure back to the caller instead of silently
 * swallowing it — the user clicked something and needs to know whether it
 * actually took effect.
 *
 * @param {string} hash
 * @param {{title?: string, notes?: string, tags?: string[], favorite?: boolean, visibility?: string, graphColorHex?: string}} updates
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, metadata: object}|{ok: false}>}
 */
export const updateLocalGraphMetadata = async (hash, updates, { timeoutMs = BROWSER_TIMEOUT_MS } = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/local-graphs/${encodeURIComponent(hash)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: Graph Database metadata update returned ${res.status}`);
      return { ok: false };
    }
    const body = await res.json();
    devLog('Renderer: Updated graph metadata in the local Graph Database');
    return { ok: true, metadata: body.metadata };
  } catch (err) {
    devWarn('Renderer: Graph Database metadata update unavailable', err);
    return { ok: false };
  }
};

/**
 * Deletes a graph from the local GraphDatabase entirely (metadata, points,
 * and notes together) — the Graph Database browser's Delete action.
 * Reports success/failure back to the caller for the same reason
 * updateLocalGraphMetadata does.
 *
 * @param {string} hash
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<boolean>} whether the delete request completed successfully.
 */
export const deleteLocalGraph = async (hash, { timeoutMs = BROWSER_TIMEOUT_MS } = {}) => {
  try {
    const res = await fetchWithTimeout(`${apiBaseUrl()}/api/local-graphs/${encodeURIComponent(hash)}`, { method: 'DELETE' }, timeoutMs);
    if (!res.ok) {
      devWarn(`Renderer: Graph Database delete returned ${res.status}`);
      return false;
    }
    devLog('Renderer: Deleted graph from the local Graph Database');
    return true;
  } catch (err) {
    devWarn('Renderer: Graph Database delete unavailable', err);
    return false;
  }
};
