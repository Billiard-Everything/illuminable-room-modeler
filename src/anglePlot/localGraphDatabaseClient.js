// LocalGraphDatabaseClient: the browser's own gateway to its Graph
// Database.
//
// Direction change: this used to be a thin HTTP client for a server-side
// file-based store (server/graphDatabase/graphDatabase.js, via
// server/api/app.js's /api/local-graphs routes). It no longer talks to the
// server at all — every function here now reads/writes
// src/graphLibrary/browserGraphDatabaseStore.js directly, which persists to
// this browser's own storage. Every graph a user computes now lives, and
// autosaves immediately, in the browser that computed it; nothing is
// shared across browsers/devices by this store (the GitHub-backed and
// PostgreSQL-backed shared libraries still exist for that, untouched, and
// are no longer this app's primary store).
//
// The function names, signatures, and return shapes below are all
// deliberately unchanged from the previous HTTP-backed version, so every
// existing call site (the render pipeline's cache-check, the "Save Graph"
// button, the Graph Database browser) keeps working without modification —
// only the implementation underneath moved from a network round trip to a
// synchronous local read/write. Every function still returns a Promise
// (resolved immediately) purely to preserve that existing async contract.

import { devLog, devWarn } from './apiClientUtils.js';
import { browserGraphDatabase } from '../graphLibrary/browserGraphDatabaseStore.js';
import { LOCAL_GRAPH_SORT } from '../graphLibrary/localGraphDatabaseConstants.js';

const SORT_TO_OPTIONS = {
  [LOCAL_GRAPH_SORT.NEWEST]: { sortBy: 'createdAt', order: 'desc' },
  [LOCAL_GRAPH_SORT.OLDEST]: { sortBy: 'createdAt', order: 'asc' },
  [LOCAL_GRAPH_SORT.RECENTLY_MODIFIED]: { sortBy: 'modifiedAt', order: 'desc' },
  [LOCAL_GRAPH_SORT.TITLE_ASC]: { sortBy: 'title', order: 'asc' },
};
const DEFAULT_SORT_OPTIONS = SORT_TO_OPTIONS[LOCAL_GRAPH_SORT.NEWEST];

/**
 * Looks up the exact geometry for `hash` in the browser's Graph Database.
 *
 * @param {string} hash - graphHasher.js's hashGraph output.
 * @returns {Promise<{points: Array, durationMs: number|null}|null>} null
 *   for "not found" — callers never need to distinguish that from any other
 *   outcome, since both mean "fall back to local computation."
 */
export const fetchLocalExactGraph = async (hash) => {
  try {
    const graph = browserGraphDatabase.loadGraph(hash);
    if (!graph) return null;
    devLog(`Renderer: browser Graph Database has this exact graph (${graph.points.length} points)`);
    return { points: graph.points, durationMs: graph.metadata?.computeTimeMs ?? null };
  } catch (err) {
    devWarn('Renderer: browser Graph Database lookup failed, continuing without it', err);
    return null;
  }
};

/**
 * Saves a freshly-computed exact graph to the browser's Graph Database
 * (always an upsert, keyed by hash — see browserGraphDatabaseStore.js's
 * saveGraph). Persists immediately; there is no separate "commit" step.
 *
 * @param {object} params - graphParamsFromSequence's shape (graph.js).
 * @param {number} algorithmVersion - unused here; browserGraphDatabaseStore.js derives its own from the same graphHasher.js constant — kept for signature parity with the sibling remote-repository clients.
 * @param {Array} points
 * @param {number|null} durationMs
 * @param {{title?: string, graphColorHex?: string, notes?: string, tags?: string[], favorite?: boolean, visibility?: string, maxBounces?: number}} [options] -
 *   the row's own richer metadata (sequenceGraphConfig.js's createSequenceRow),
 *   threaded straight through to browserGraphDatabaseStore.js's saveGraph.
 * @returns {Promise<boolean>} never rejects; returns whether the save
 *   actually succeeded (e.g. false on storage-quota exceeded) — the
 *   automatic background-exact call site ignores this (fire-and-forget by
 *   design), but the explicit "Save Graph" button needs to report success
 *   or failure back to the person who clicked it.
 */
export const saveLocalExactGraph = async (params, algorithmVersion, points, durationMs, {
  title, graphColorHex, notes, tags, favorite, visibility, maxBounces,
} = {}) => {
  try {
    browserGraphDatabase.saveGraph({ params, points, computeTimeMs: durationMs, title, graphColorHex, notes, tags, favorite, visibility, maxBounces });
    devLog('Renderer: saved exact graph to the browser Graph Database');
    return true;
  } catch (err) {
    devWarn('Renderer: browser Graph Database save failed, exact graph stays uncached for now', err);
    return false;
  }
};

/**
 * Fetches a graph's full stored record — points AND notes together (unlike
 * fetchLocalExactGraph, which only ever returns {points, durationMs} for
 * the render pipeline's own cache-hit path). Used by the Graph Database
 * browser the moment a card is selected.
 *
 * @param {string} hash
 * @returns {Promise<{points: Array, durationMs: number|null, notes: string}|null>}
 */
export const fetchLocalGraphDetails = async (hash) => {
  try {
    const graph = browserGraphDatabase.loadGraph(hash);
    if (!graph) return null;
    return { points: graph.points, durationMs: graph.metadata?.computeTimeMs ?? null, notes: graph.notes ?? '' };
  } catch (err) {
    devWarn('Renderer: browser Graph Database detail lookup failed', err);
    return null;
  }
};

/**
 * Browses or searches the browser's Graph Database metadata (never
 * geometry). Used by the Graph Database browser (src/graphLibrary/**) —
 * nothing in the rendering pipeline calls this.
 *
 * @param {object} [params]
 * @param {string} [params.sort] - one of localGraphDatabaseConstants.js's LOCAL_GRAPH_SORT values.
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @param {{text?: string, title?: string, code?: string, angleA?: number, angleB?: number, baseLength?: number, favorite?: boolean, visibility?: string, tags?: string[]}} [params.search]
 * @returns {Promise<{graphs: Array, error: boolean}>} `error` is always
 *   false here (kept in the return shape for call-site compatibility) since
 *   a local read has no network to fail; a genuinely corrupt storage blob
 *   still resolves to an empty list rather than throwing.
 */
export const fetchLocalGraphLibraryPage = async ({ sort, limit, offset, search = {} } = {}) => {
  try {
    const { sortBy, order } = (sort && SORT_TO_OPTIONS[sort]) || DEFAULT_SORT_OPTIONS;

    const hasSearch = search.text || search.title || search.code
      || (search.angleA !== undefined && search.angleA !== '')
      || (search.angleB !== undefined && search.angleB !== '')
      || (search.baseLength !== undefined && search.baseLength !== '')
      || search.favorite || search.visibility || (search.tags && search.tags.length > 0);

    let graphs;
    if (hasSearch) {
      const query = {};
      if (search.text) query.text = search.text;
      if (search.title) query.title = search.title;
      if (search.code) query.codeSequence = search.code;
      if (search.angleA !== undefined && search.angleA !== '') query.angleA = Number(search.angleA);
      if (search.angleB !== undefined && search.angleB !== '') query.angleB = Number(search.angleB);
      if (search.baseLength !== undefined && search.baseLength !== '') query.baseLength = Number(search.baseLength);
      if (search.favorite) query.favorite = true;
      if (search.visibility) query.visibility = search.visibility;
      if (search.tags && search.tags.length > 0) query.tags = search.tags;
      graphs = browserGraphDatabase.searchGraphs(query, { sortBy, order });
    } else {
      graphs = browserGraphDatabase.listGraphs({ sortBy, order });
    }

    if (offset !== undefined) graphs = graphs.slice(offset);
    if (limit !== undefined) graphs = graphs.slice(0, limit);
    return { graphs, error: false };
  } catch (err) {
    devWarn('Renderer: browser Graph Database browse/search failed', err);
    return { graphs: [], error: true };
  }
};

/**
 * Partial-updates a graph's metadata (rename, favorite, tags, notes,
 * visibility, color) — an explicit, user-initiated librarian action.
 *
 * @param {string} hash
 * @param {{title?: string, notes?: string, tags?: string[], favorite?: boolean, visibility?: string, graphColorHex?: string, maxBounces?: number}} updates
 * @returns {Promise<{ok: true, metadata: object}|{ok: false}>}
 */
export const updateLocalGraphMetadata = async (hash, updates) => {
  try {
    const metadata = browserGraphDatabase.updateGraphMetadata(hash, updates);
    devLog('Renderer: updated graph metadata in the browser Graph Database');
    return { ok: true, metadata };
  } catch (err) {
    devWarn('Renderer: browser Graph Database metadata update failed', err);
    return { ok: false };
  }
};

/**
 * Deletes a graph from the browser's Graph Database entirely (metadata,
 * points, and notes together) — the Graph Database browser's Delete action.
 *
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export const deleteLocalGraph = async (hash) => {
  try {
    browserGraphDatabase.deleteGraph(hash);
    devLog('Renderer: deleted graph from the browser Graph Database');
    return true;
  } catch (err) {
    devWarn('Renderer: browser Graph Database delete failed', err);
    return false;
  }
};

/**
 * Exports the complete browser Graph Database as one plain-data object,
 * ready for `JSON.stringify` into a downloadable file — the "Export
 * Database" button's own action.
 *
 * @returns {Promise<{version: number, exportedAt: string, graphs: Array}>}
 */
export const exportLocalGraphDatabase = async () => browserGraphDatabase.exportDatabase();

/**
 * Imports a previously-exported database (exportLocalGraphDatabase's own
 * output shape). Deduplicates by graph hash — an imported graph whose hash
 * already exists locally is skipped, never overwritten; every imported
 * graph's own owner/metadata is preserved exactly as exported.
 *
 * @param {object} data - parsed JSON from a previously exported file.
 * @returns {Promise<{imported: number, duplicates: number, total: number}>}
 */
export const importLocalGraphDatabase = async (data) => browserGraphDatabase.importDatabase(data);
