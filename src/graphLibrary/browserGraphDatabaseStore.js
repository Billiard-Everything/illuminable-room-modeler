// BrowserGraphDatabaseStore: the browser's own primary Graph Database.
//
// Direction change (see this feature's own task): the PostgreSQL-backed
// shared library (server/db/**, server/repositories/graphRepository.js) and
// the GitHub-repo-backed cloud store (server/graphDatabase/
// githubGraphDatabase.js) are both left exactly as they are — not extended,
// not removed — but neither is the app's *primary* graph store anymore.
// Every browser now keeps its own complete, independent Graph Database
// entirely in its own storage (localStorage by default), with the exact
// same metadata shape server/graphDatabase/graphDatabase.js already
// established (title/description/author/codeSequence/angleA/angleB/
// angleStep/baseLength/maxBounces/graphColorHex/tags/favorite/visibility/
// notes/points/timestamps/hash) plus `maxBounces`, which no prior store
// tracked.
//
// This is a synchronous module by design: reading/writing localStorage has
// no meaningful latency worth an async API, and every existing call site in
// localGraphDatabaseClient.js already tolerates (in fact expects) instant
// resolution — that file wraps these calls in `Promise.resolve(...)` purely
// to keep its own already-established async contract, not because this
// store needs one.
//
// One JSON blob under one storage key holds the whole database, keyed by
// graph hash — same identity rule as every other store in this project
// (src/anglePlot/graphHasher.js's hashGraph is the single source of truth
// for what "the same graph" means everywhere), and the same key makes
// hash-based dedup (this feature's own Import requirement) an O(1) lookup
// rather than a linear scan.
//
// Backend injection mirrors src/workspace/workspaceManager.js's own
// established pattern exactly: every function accepts an optional
// `{getItem, setItem, removeItem}` backend, defaulting to real
// window.localStorage, so tests can swap in an isolated in-memory
// implementation without this module ever knowing the difference.

import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../anglePlot/graphHasher.js';
import { GRAPH_VISIBILITY, resolveDefaultOwner, buildNotesPreview, generateId } from './browserGraphDatabaseShared.js';

export { GRAPH_VISIBILITY };

const STORAGE_KEY = 'illuminable-graph-database';
const SCHEMA_VERSION = 1;

const defaultBackend = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};

const range = (values) => {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: null, max: null };
  return { min: Math.min(...finite), max: Math.max(...finite) };
};

/** Reads the whole database blob, tolerating anything corrupt/missing exactly like workspaceManager.js's loadWorkspace does — never throws, always returns a usable shape. */
const readStore = (backend) => {
  try {
    const raw = backend.getItem(STORAGE_KEY);
    if (!raw) return { graphs: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.graphs !== 'object' || parsed.graphs === null) return { graphs: {} };
    return { graphs: parsed.graphs };
  } catch {
    return { graphs: {} };
  }
};

/** Writes the whole database blob back — every mutating operation below calls this immediately (see this feature's own "autosave immediately whenever it changes" requirement), never debounced or batched. Returns whether the write actually succeeded (false on e.g. quota exceeded), never throws. */
const writeStore = (store, backend) => {
  try {
    backend.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, graphs: store.graphs }));
    return true;
  } catch {
    return false;
  }
};

const toGraphObject = (metadata, points, notes) => ({ id: metadata.id, hash: metadata.hash, metadata, points, notes });

/**
 * Builds the metadata shape for a save, preserving id/createdAt from
 * `existing` if this hash was already stored — same contract as
 * server/graphDatabase/graphDatabase.js's own buildMetadata, plus
 * `maxBounces` (this feature's own new field; no prior store tracked it,
 * so there is no existing-record precedent to preserve it *from* other than
 * this same store).
 */
const buildMetadata = ({ hash, params, points, title, description, author, graphColorHex, tags, favorite, visibility, computeTimeMs, notes, maxBounces }, existing, backend) => {
  const now = new Date().toISOString();
  const xs = range(points.map((p) => p.a));
  const ys = range(points.map((p) => p.b));
  return {
    id: existing?.id ?? generateId(),
    hash,
    title: title ?? existing?.title ?? '',
    description: description ?? existing?.description ?? '',
    author: author !== undefined ? author : (existing?.author ?? resolveDefaultOwner(backend)),
    codeSequence: params.sequenceText,
    angleA: params.angleA,
    angleB: params.angleB,
    angleStep: params.angleStepInput,
    baseLength: params.baseLength,
    maxBounces: maxBounces !== undefined ? maxBounces : (existing?.maxBounces ?? null),
    graphColorHex: graphColorHex !== undefined ? graphColorHex : (existing?.graphColorHex ?? null),
    createdAt: existing?.createdAt ?? now,
    modifiedAt: now,
    algorithmVersion: GRAPH_HASH_ALGORITHM_VERSION,
    pointCount: points.length,
    computeTimeMs: computeTimeMs !== undefined ? computeTimeMs : (existing?.computeTimeMs ?? null),
    minX: xs.min, maxX: xs.max, minY: ys.min, maxY: ys.max,
    tags: tags ?? existing?.tags ?? [],
    favorite: favorite ?? existing?.favorite ?? false,
    visibility: visibility ?? existing?.visibility ?? GRAPH_VISIBILITY.PRIVATE,
    notesPreview: notes !== undefined ? buildNotesPreview(notes) : (existing?.notesPreview ?? ''),
  };
};

/**
 * Builds a GraphDatabase backed by browser storage. A factory (not a bare
 * module singleton) so tests can inject an isolated in-memory backend —
 * see createBrowserGraphDatabase's own callers in
 * tests/browser-graph-database.test.mjs.
 */
export const createBrowserGraphDatabase = (backend = defaultBackend) => ({
  /**
   * Saves (creating or overwriting) the graph identified by `params` —
   * always synchronous and always durable the moment this returns (see
   * writeStore's own comment on the "autosave immediately" requirement).
   * id/createdAt are preserved across an overwrite of an already-stored
   * hash; only geometry/metadata/timestamps are ever replaced.
   *
   * @returns {{id, hash, metadata, points, notes}}
   */
  saveGraph({ params, points, title, description, author, graphColorHex, tags, favorite, visibility, computeTimeMs, notes, maxBounces }) {
    const hash = hashGraph(params);
    const store = readStore(backend);
    const existing = store.graphs[hash]?.metadata;
    const metadata = buildMetadata({ hash, params, points, title, description, author, graphColorHex, tags, favorite, visibility, computeTimeMs, notes, maxBounces }, existing, backend);
    // notes.md's own "never clobber existing notes without an explicit
    // value" rule (server/graphDatabase/graphDatabase.js's saveGraph) —
    // mirrored here since this is the same field with the same intent.
    const savedNotes = notes !== undefined ? notes : (store.graphs[hash]?.notes ?? '');
    const record = toGraphObject(metadata, points, savedNotes);
    store.graphs[hash] = record;
    writeStore(store, backend);
    return record;
  },

  /** @returns {{id, hash, metadata, points, notes}|null} */
  loadGraph(hash) {
    return readStore(backend).graphs[hash] ?? null;
  },

  /** Whether a graph with this hash has ever been saved. */
  graphExists(hash) {
    return Boolean(readStore(backend).graphs[hash]);
  },

  /** Deletes a graph entirely. A no-op if it was never stored. */
  deleteGraph(hash) {
    const store = readStore(backend);
    if (!(hash in store.graphs)) return;
    delete store.graphs[hash];
    writeStore(store, backend);
  },

  /** Changes a graph's display `title` only. Throws if the graph doesn't exist — a thin wrapper over updateGraphMetadata, same as the server-side store's own renameGraph. */
  renameGraph(hash, newTitle) {
    return this.updateGraphMetadata(hash, { title: newTitle });
  },

  /**
   * Partial-updates a graph's metadata (and notes, if provided) — never its
   * hash/id/createdAt/points, which stay permanent. Every field is optional
   * and independently defaulted to its current value when omitted. Throws
   * if the graph doesn't exist, matching the server-side store's contract.
   *
   * @returns {object} the updated metadata.
   */
  updateGraphMetadata(hash, { title, description, author, graphColorHex, tags, favorite, visibility, notes, maxBounces } = {}) {
    const store = readStore(backend);
    const existing = store.graphs[hash];
    if (!existing) throw new Error(`No graph stored for hash: ${hash}`);
    const metadata = {
      ...existing.metadata,
      title: title !== undefined ? title : existing.metadata.title,
      description: description !== undefined ? description : existing.metadata.description,
      author: author !== undefined ? author : existing.metadata.author,
      graphColorHex: graphColorHex !== undefined ? graphColorHex : existing.metadata.graphColorHex,
      tags: tags !== undefined ? tags : existing.metadata.tags,
      favorite: favorite !== undefined ? favorite : existing.metadata.favorite,
      visibility: visibility !== undefined ? visibility : existing.metadata.visibility,
      maxBounces: maxBounces !== undefined ? maxBounces : existing.metadata.maxBounces,
      notesPreview: notes !== undefined ? buildNotesPreview(notes) : existing.metadata.notesPreview,
      modifiedAt: new Date().toISOString(),
    };
    const notesText = notes !== undefined ? notes : existing.notes;
    store.graphs[hash] = { ...existing, metadata, notes: notesText };
    writeStore(store, backend);
    return metadata;
  },

  /**
   * Every stored graph's metadata (never geometry/notes — mirrors the
   * server-side store's own "metadata only while listing" rule), optionally
   * sorted.
   *
   * @param {{sortBy?: string, order?: 'asc'|'desc'}} [options]
   */
  listGraphs({ sortBy = 'createdAt', order = 'desc' } = {}) {
    const store = readStore(backend);
    const entries = Object.values(store.graphs).map((record) => record.metadata);
    const direction = order === 'asc' ? 1 : -1;
    entries.sort((a, b) => {
      const left = a[sortBy] ?? '';
      const right = b[sortBy] ?? '';
      return left < right ? -direction : left > right ? direction : 0;
    });
    return entries;
  },

  /**
   * Filters listGraphs' own results — same query shape and semantics as the
   * server-side store's own searchGraphs (partial match on title/
   * description/codeSequence, exact match on angleA/angleB/baseLength/
   * algorithmVersion/favorite/visibility, "any of these tags" for tags,
   * plus `query.text`: a free-text OR across title/codeSequence/author/
   * hash/tags/notes). Notes are already in memory here (no separate file to
   * avoid reading), so there is no cost-avoidance ordering to preserve —
   * every filter is just a plain in-memory check.
   */
  searchGraphs(query = {}, options = {}) {
    const store = readStore(backend);
    const all = this.listGraphs(options);
    const contains = (haystack, needle) => (haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
    const matchesText = (metadata, text) => (
      contains(metadata.title, text)
      || contains(metadata.codeSequence, text)
      || contains(metadata.author, text)
      || contains(metadata.hash, text)
      || (metadata.tags ?? []).some((tag) => contains(tag, text))
      || contains(store.graphs[metadata.hash]?.notes, text)
    );

    return all.filter((metadata) => {
      if (query.title && !contains(metadata.title, query.title)) return false;
      if (query.description && !contains(metadata.description, query.description)) return false;
      if (query.codeSequence && !contains(metadata.codeSequence, query.codeSequence)) return false;
      if (query.angleA !== undefined && metadata.angleA !== Number(query.angleA)) return false;
      if (query.angleB !== undefined && metadata.angleB !== Number(query.angleB)) return false;
      if (query.baseLength !== undefined && metadata.baseLength !== Number(query.baseLength)) return false;
      if (query.algorithmVersion !== undefined && metadata.algorithmVersion !== Number(query.algorithmVersion)) return false;
      if (query.favorite !== undefined && metadata.favorite !== Boolean(query.favorite)) return false;
      if (query.visibility && metadata.visibility !== query.visibility) return false;
      if (query.tags && query.tags.length > 0 && !query.tags.some((tag) => (metadata.tags ?? []).includes(tag))) return false;
      if (query.text && !matchesText(metadata, query.text)) return false;
      return true;
    });
  },

  /**
   * Exports the complete database as one plain-data object, suitable for
   * `JSON.stringify` straight to a downloadable file — every full graph
   * record (metadata + points + notes), not just the metadata listGraphs
   * exposes, since a round-tripped import must be able to fully restore
   * geometry without recomputing anything (this feature's own "loading a
   * graph must never recompute" requirement applies just as much to a
   * graph that arrived via Import as to one that was always local).
   */
  exportDatabase() {
    const store = readStore(backend);
    return { version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), graphs: Object.values(store.graphs) };
  },

  /**
   * Imports a previously-exported database. Compares by graph hash — an
   * imported record whose hash already exists locally is skipped entirely
   * (never overwrites an existing local graph), and every imported record's
   * own `author`/metadata is stored exactly as exported, never rewritten to
   * the importing browser's own owner (this feature's own "preserve the
   * owner of imported graphs" requirement).
   *
   * @param {{graphs?: Array}} data - the parsed JSON from exportDatabase's own output shape.
   * @returns {{imported: number, duplicates: number, total: number}}
   */
  importDatabase(data) {
    const store = readStore(backend);
    let imported = 0;
    let duplicates = 0;
    for (const record of (Array.isArray(data?.graphs) ? data.graphs : [])) {
      const hash = record?.hash ?? record?.metadata?.hash;
      if (!hash || !record?.metadata) continue;
      if (store.graphs[hash]) { duplicates += 1; continue; }
      store.graphs[hash] = { id: record.id ?? record.metadata.id ?? generateId(), hash, metadata: record.metadata, points: Array.isArray(record.points) ? record.points : [], notes: typeof record.notes === 'string' ? record.notes : '' };
      imported += 1;
    }
    writeStore(store, backend);
    return { imported, duplicates, total: Object.keys(store.graphs).length };
  },
});

// The default, browser-storage-backed singleton every call site in this app
// actually uses — see localGraphDatabaseClient.js, the one module allowed
// to import this file directly (mirrors every other storage layer in this
// project having exactly one gateway module).
export const browserGraphDatabase = createBrowserGraphDatabase();
