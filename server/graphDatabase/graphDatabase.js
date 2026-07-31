// GraphDatabase: a file-based graph library — the ONLY place in this
// module responsible for deciding what a saved graph *is* and how its
// metadata/points/notes are organized (server/graphDatabase/graphFileStore.js
// is the only place that touches the filesystem itself; this file never
// calls `fs` directly, mirroring GraphRepository's own "one module owns
// SQL" rule for its own storage layer).
//
// Deliberately NOT a replacement for the PostgreSQL-backed shared library
// (server/repositories/graphRepository.js, server/api/**): that system is
// the one deployed to Render/Supabase for multiple users (including a
// professor) to share graphs over the internet, and Render's web service
// filesystem is ephemeral — anything this module wrote there would be
// silently deleted on the next restart/redeploy. This module is a
// separate, additive graph library meant for local/offline use (or a
// future desktop-style deployment with a real persistent disk), with a
// richer per-graph metadata shape (title, description, notes, tags,
// favorite) the shared library's schema doesn't have. Nothing here is
// wired into server/api/** or src/**; see this task's own scope note.
//
// Graph identity
// ---------------
// Every graph's hash comes from src/anglePlot/graphHasher.js's hashGraph —
// the exact same function (never re-derived here) the browser's GraphCache
// and the PostgreSQL-backed library both already use, so "the same graph"
// means the same thing everywhere in this project. hashGraph's own inputs
// (code sequence, Angle A, Angle B, Angle Step, Base Length) plus its
// baked-in GRAPH_HASH_ALGORITHM_VERSION are exactly the six inputs this
// module's own hash requirement lists — reusing it rather than writing a
// second hash function is what keeps that true by construction instead of
// by convention.
//
// File layout (see graphFileStore.js for the raw I/O this builds on)
// -------------------------------------------------------------------
//   GraphLibrary/graph_<hash>/metadata.json
//   GraphLibrary/graph_<hash>/points.json
//   GraphLibrary/graph_<hash>/notes.md

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../../src/anglePlot/graphHasher.js';
import {
  resolveLibraryDir, graphDirPath, atomicWriteJson, atomicWriteFile,
  readJsonIfExists, readTextIfExists, pathExists, ensureDir, removeDir, listGraphDirs,
} from './graphFileStore.js';

const METADATA_FILE = 'metadata.json';
const POINTS_FILE = 'points.json';
const NOTES_FILE = 'notes.md';

/** Allowed values for a graph's `visibility` metadata field. Plain data — see this module's own header comment on why this isn't an enforced permission system. */
export const GRAPH_VISIBILITY = { PRIVATE: 'private', SHARED: 'shared', PUBLIC: 'public' };

const range = (values) => {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: null, max: null };
  return { min: Math.min(...finite), max: Math.max(...finite) };
};

/** Builds the metadata.json shape from a save request + points, preserving id/createdAt from `existing` if this hash was already stored. */
const buildMetadata = ({ hash, params, points, title, description, author, graphColorHex, tags, favorite, visibility, computeTimeMs }, existing) => {
  const now = new Date().toISOString();
  const xs = range(points.map((p) => p.a));
  const ys = range(points.map((p) => p.b));
  return {
    id: existing?.id ?? randomUUID(),
    hash,
    title: title ?? existing?.title ?? '',
    description: description ?? existing?.description ?? '',
    author: author !== undefined ? author : (existing?.author ?? null),
    codeSequence: params.sequenceText,
    angleA: params.angleA,
    angleB: params.angleB,
    angleStep: params.angleStepInput,
    baseLength: params.baseLength,
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
  };
};

const toGraphObject = (metadata, points, notes) => ({
  id: metadata.id,
  hash: metadata.hash,
  metadata,
  points,
  notes,
});

/**
 * Builds a GraphDatabase bound to `baseDir` (defaults to GRAPH_LIBRARY_DIR
 * or ./GraphLibrary — see graphFileStore.js). A factory, not a bare module
 * singleton, so tests can point an isolated instance at a temp directory
 * without touching a real graph library (see graph-database.test.mjs) —
 * the same reasoning createGraphRepository's own factory design already
 * established for the SQL-backed library.
 */
export const createGraphDatabase = (baseDir) => {
  const libraryDir = resolveLibraryDir(baseDir);
  const dirFor = (hash) => graphDirPath(libraryDir, hash);

  return {
    /**
     * Saves (creating or overwriting) the graph identified by `params`.
     * `id`/`createdAt`/notes.md are preserved across an overwrite of an
     * already-stored graph — only its geometry/metadata/timestamps are
     * ever replaced by a later save for the same hash.
     *
     * @returns {Promise<{id, hash, metadata, points, notes}>}
     */
    async saveGraph({ params, points, title, description, author, graphColorHex, tags, favorite, visibility, computeTimeMs, notes }) {
      const hash = hashGraph(params);
      const dir = dirFor(hash);
      const existing = await readJsonIfExists(path.join(dir, METADATA_FILE));
      const metadata = buildMetadata({ hash, params, points, title, description, author, graphColorHex, tags, favorite, visibility, computeTimeMs }, existing);

      await ensureDir(dir);
      await atomicWriteJson(path.join(dir, METADATA_FILE), metadata);
      await atomicWriteJson(path.join(dir, POINTS_FILE), points);

      // notes.md is user-authored free text (requirement #7) — a save
      // never clobbers existing notes; only an explicit notes value (or a
      // genuinely new graph, which starts with empty notes) touches it.
      const notesPath = path.join(dir, NOTES_FILE);
      if (notes !== undefined) {
        await atomicWriteFile(notesPath, notes);
      } else if (!existing) {
        await atomicWriteFile(notesPath, '');
      }

      const savedNotes = notes !== undefined ? notes : await readTextIfExists(notesPath, '');
      return toGraphObject(metadata, points, savedNotes);
    },

    /** @returns {Promise<{id, hash, metadata, points, notes}|null>} */
    async loadGraph(hash) {
      const dir = dirFor(hash);
      const metadata = await readJsonIfExists(path.join(dir, METADATA_FILE));
      if (!metadata) return null;
      const points = (await readJsonIfExists(path.join(dir, POINTS_FILE))) ?? [];
      const notes = await readTextIfExists(path.join(dir, NOTES_FILE), '');
      return toGraphObject(metadata, points, notes);
    },

    /** Whether a graph with this hash has ever been saved — no read of its contents. */
    async graphExists(hash) {
      return pathExists(path.join(dirFor(hash), METADATA_FILE));
    },

    /** Deletes a graph's entire directory (metadata, points, and notes together). A no-op if it was never stored. */
    async deleteGraph(hash) {
      await removeDir(dirFor(hash));
    },

    /**
     * Changes a graph's display `title` — never its hash or directory,
     * which stay permanent/content-derived (see this module's own header
     * comment on graph identity). Throws if the graph doesn't exist. A thin
     * wrapper over updateGraphMetadata, kept as its own method since "rename"
     * is the one metadata edit with dedicated UI (the Graph Database
     * browser's rename action) and its own, narrower single-argument shape.
     *
     * @returns {Promise<object>} the updated metadata.
     */
    async renameGraph(hash, newTitle) {
      return this.updateGraphMetadata(hash, { title: newTitle });
    },

    /**
     * Partial-updates a graph's metadata.json (title/description/author/
     * graphColorHex/tags/favorite/visibility) and, if `notes` is provided,
     * its notes.md — never its hash/directory/points.json/createdAt, which
     * stay permanent (see this module's own header comment on graph
     * identity; only saveGraph ever rewrites points.json, since that's the
     * one file a metadata-only edit has no business touching). Every field
     * is optional and independently defaulted to its current value when
     * omitted, so a caller can change just one field (e.g. only toggling
     * `favorite`) without needing to first read back and resend everything
     * else. Throws if the graph doesn't exist, matching renameGraph's own
     * existing contract.
     *
     * @param {{title?: string, description?: string, author?: string|null, graphColorHex?: string|null, tags?: string[], favorite?: boolean, visibility?: string, notes?: string}} updates
     * @returns {Promise<object>} the updated metadata (never notes/points — see loadGraph for the full object).
     */
    async updateGraphMetadata(hash, { title, description, author, graphColorHex, tags, favorite, visibility, notes } = {}) {
      const dir = dirFor(hash);
      const metadataPath = path.join(dir, METADATA_FILE);
      const metadata = await readJsonIfExists(metadataPath);
      if (!metadata) throw new Error(`No graph stored for hash: ${hash}`);
      const updated = {
        ...metadata,
        title: title !== undefined ? title : metadata.title,
        description: description !== undefined ? description : metadata.description,
        author: author !== undefined ? author : metadata.author,
        graphColorHex: graphColorHex !== undefined ? graphColorHex : metadata.graphColorHex,
        tags: tags !== undefined ? tags : metadata.tags,
        favorite: favorite !== undefined ? favorite : metadata.favorite,
        visibility: visibility !== undefined ? visibility : metadata.visibility,
        modifiedAt: new Date().toISOString(),
      };
      await atomicWriteJson(metadataPath, updated);
      if (notes !== undefined) await atomicWriteFile(path.join(dir, NOTES_FILE), notes);
      return updated;
    },

    /**
     * Every stored graph's metadata (never geometry — mirrors the
     * PostgreSQL-backed library's own "metadata only while browsing" rule;
     * see server/repositories/graphRepository.js's queryGraphs), optionally
     * sorted. A directory whose metadata.json fails to parse is skipped
     * rather than failing the whole listing.
     *
     * @param {{sortBy?: 'createdAt'|'modifiedAt'|'title', order?: 'asc'|'desc'}} [options]
     */
    async listGraphs({ sortBy = 'createdAt', order = 'desc' } = {}) {
      const dirs = await listGraphDirs(libraryDir);
      const entries = [];
      for (const dir of dirs) {
        const metadata = await readJsonIfExists(path.join(dir, METADATA_FILE));
        if (metadata) entries.push(metadata);
      }
      const direction = order === 'asc' ? 1 : -1;
      entries.sort((a, b) => {
        const left = a[sortBy] ?? '';
        const right = b[sortBy] ?? '';
        return left < right ? -direction : left > right ? direction : 0;
      });
      return entries;
    },

    /**
     * Filters listGraphs' own results — partial (substring) match on
     * title/description/codeSequence, exact match on angleA/angleB/
     * baseLength/algorithmVersion/favorite/visibility, "any of these tags"
     * for tags. Every filter is optional and ANDed together with the
     * others actually provided.
     */
    async searchGraphs(query = {}, options = {}) {
      const all = await this.listGraphs(options);
      const contains = (haystack, needle) => (haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
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
        return true;
      });
    },
  };
};

// The default library instance — GRAPH_LIBRARY_DIR env var, or
// ./GraphLibrary. Not auto-created on import (see ensureDir's own call
// site, inside saveGraph): importing this module never touches the
// filesystem by itself.
export const graphDatabase = createGraphDatabase();
