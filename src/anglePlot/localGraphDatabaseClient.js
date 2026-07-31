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
