// GithubGraphDatabase: a GraphDatabase implementation with the EXACT same
// public method surface as graphDatabase.js's own local, file-based
// createGraphDatabase (saveGraph/loadGraph/graphExists/deleteGraph/
// renameGraph/updateGraphMetadata/listGraphs/searchGraphs — same
// parameter shapes, same return shapes) — backed by a GitHub repository
// instead of local disk, via githubContentsClient.js (the only module
// that ever actually calls GitHub; this file never fetches anything
// itself). Because the public surface matches exactly, nothing above this
// module — server/api/app.js's routes, AnglePlotWindow.jsx, the whole
// Graph Database browser UI — needs to know or care which store is
// actually answering. See graphDatabase.js's own resolveDefaultGraphDatabase
// for how the app decides which one to construct.
//
// Why this exists
// -----------------
// Render's web service filesystem is ephemeral (see graphDatabase.js's
// own header comment) — a permanent library shared between a professor
// and every student, reachable from nothing but a browser (no IDE, no
// cloning, no local GraphLibrary — see this task's own requirement #7),
// can't live on that disk. A GitHub repository is durable, free,
// human-browsable storage this project already has, addressed by env vars
// already configured in Render (GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO/
// GITHUB_BRANCH) that never reach the frontend — this module is the only
// thing that ever reads GITHUB_TOKEN.
//
// Repository layout
// -------------------
//   graphs/<id>/metadata.json
//   graphs/<id>/points.json
//   database/index.json
//
// `id` is a fresh randomUUID the first time a hash is ever saved (and
// preserved across every later re-save of that same hash, exactly like
// the local store's own `metadata.id`) — never derived from the hash
// itself, so a lookup by hash always goes through database/index.json
// (see findByHash below), never by guessing a path.
//
// database/index.json is a JSON array holding every graph's OWN metadata,
// in this module's stored field shape (see toRepoMetadata) — maintained
// here on every save/rename/metadata-update/delete so listGraphs/
// searchGraphs need exactly one file read, never one GitHub API call per
// graph (which would be slow and rate-limit-hungry for a real class-sized
// library, and is why requirement #4 — "maintain database/index.json
// automatically" — exists at all). It's also the FAST path for a
// hash-based lookup (loadGraph/graphExists/saveGraph's own "does this
// hash already exist" check): one small file read beats guessing a path
// from the hash.
//
// Field-shape translation
// -------------------------
// The JSON actually stored in this repo uses the field names this task's
// own requirement #2 specifies (id/title/owner/code/angleA/angleB/
// angleStep/baseLength/colourHex/tags/notes/favourite/visibility/
// pointCount/graphHash/createdAt/modifiedAt — notes inline, not a
// separate notes.md the way the local store keeps it). toRepoMetadata/
// fromRepoMetadata are the only two functions that ever see both this
// shape AND the shape every caller above this module actually expects
// (graphDatabase.js's own codeSequence/graphColorHex/author/favorite/
// notesPreview/... field names) — every public method below only ever
// speaks the latter, exactly like the local store.
//
// A field the local store tracks that this repo schema has no room for
// (description, computeTimeMs, algorithmVersion beyond the constant,
// minX/maxX/minY/maxY) is simply never persisted here and comes back as
// null/a fixed default — none of these are surfaced anywhere in the
// current UI, so this is a real but currently invisible gap, not a
// regression.
//
// Fallback to local storage (requirement #7)
// ----------------------------------------------
// Every method here tries GitHub first; if that throws for any reason
// (network error, bad/expired token, GitHub down, a real API error) it
// falls back to `fallback` — a plain local GraphDatabase instance
// (graphDatabase.js's own createGraphDatabase — reused, not
// reimplemented) — so a GitHub outage degrades this app back to exactly
// its pre-GitHub behavior rather than breaking plotting. loadGraph/
// graphExists/updateGraphMetadata/deleteGraph also fall back to local on
// a plain GitHub *miss* (reachable, but this hash isn't in the index) —
// not just a thrown error — because a graph saved locally during a prior
// outage must still be found without recomputing once GitHub is reachable
// again but hasn't caught up yet (requirement #3: "never recompute saved
// graphs").

import { randomUUID } from 'node:crypto';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../../src/anglePlot/graphHasher.js';
import { createGithubContentsClient } from './githubContentsClient.js';
import { GRAPH_VISIBILITY, resolveDefaultAuthor, buildNotesPreview } from './graphDatabaseShared.js';

const INDEX_PATH = 'database/index.json';
const graphDir = (id) => `graphs/${id}`;
const metadataPath = (id) => `${graphDir(id)}/metadata.json`;
const pointsPath = (id) => `${graphDir(id)}/points.json`;

const devWarn = (operation, err) => {
  console.warn(`[github-graph-database] ${operation} failed, falling back to local storage:`, err?.message ?? err);
};

/** Converts a saveGraph-style input (+ its computed hash/id) into this repo's own stored metadata.json shape (requirement #2's field list). */
const toRepoMetadata = ({ params, points, title, author, graphColorHex, tags, favorite, visibility, notes }, hash, id, existing) => ({
  id,
  title: title ?? existing?.title ?? '',
  owner: author !== undefined ? author : (existing?.owner ?? resolveDefaultAuthor()),
  code: params.sequenceText,
  angleA: params.angleA,
  angleB: params.angleB,
  angleStep: params.angleStepInput,
  baseLength: params.baseLength,
  colourHex: graphColorHex !== undefined ? graphColorHex : (existing?.colourHex ?? null),
  tags: tags ?? existing?.tags ?? [],
  notes: notes !== undefined ? notes : (existing?.notes ?? ''),
  favourite: favorite ?? existing?.favourite ?? false,
  visibility: visibility ?? existing?.visibility ?? GRAPH_VISIBILITY.PRIVATE,
  pointCount: points.length,
  graphHash: hash,
  createdAt: existing?.createdAt ?? new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
});

/** Converts this repo's own stored metadata shape back into the shape every caller above this module expects — the same shape graphDatabase.js's local store already returns. */
const fromRepoMetadata = (repo) => ({
  id: repo.id,
  hash: repo.graphHash,
  title: repo.title ?? '',
  description: '',
  author: repo.owner ?? null,
  codeSequence: repo.code ?? '',
  angleA: repo.angleA,
  angleB: repo.angleB,
  angleStep: repo.angleStep,
  baseLength: repo.baseLength,
  graphColorHex: repo.colourHex ?? null,
  createdAt: repo.createdAt,
  modifiedAt: repo.modifiedAt,
  algorithmVersion: GRAPH_HASH_ALGORITHM_VERSION,
  pointCount: repo.pointCount ?? 0,
  computeTimeMs: null,
  minX: null, maxX: null, minY: null, maxY: null,
  tags: repo.tags ?? [],
  favorite: repo.favourite ?? false,
  visibility: repo.visibility ?? GRAPH_VISIBILITY.PRIVATE,
  notesPreview: buildNotesPreview(repo.notes),
});

const toGraphObject = (repoMetadata, points) => ({
  id: repoMetadata.id,
  hash: repoMetadata.graphHash,
  metadata: fromRepoMetadata(repoMetadata),
  points,
  notes: repoMetadata.notes ?? '',
});

/**
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} [options.branch]
 * @param {object} options.fallback - a local GraphDatabase instance (graphDatabase.js's own createGraphDatabase()) used whenever GitHub can't answer.
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests (see githubContentsClient.js).
 * @param {object} [options.client] - an already-built GithubContentsClient-shaped object, for tests that want to fake getFile/putFile/deleteFile directly instead of simulating raw HTTP responses. Takes priority over token/owner/repo/branch/fetchImpl when provided.
 */
export const createGithubGraphDatabase = ({ token, owner, repo, branch = 'main', fallback, fetchImpl, client: providedClient }) => {
  const client = providedClient ?? createGithubContentsClient({ token, owner, repo, branch, fetchImpl });

  const readIndex = async () => {
    const file = await client.getFile(INDEX_PATH);
    return file ? { entries: JSON.parse(file.text || '[]'), sha: file.sha } : { entries: [], sha: undefined };
  };

  /** Writes `entries` as the new index.json. Retries once on a 409/422 (a concurrent writer updated the index between our read and this write) by refetching and re-applying `reapply` to the fresh entries. */
  const writeIndex = async (entries, sha, reapply) => {
    try {
      await client.putFile(INDEX_PATH, `${JSON.stringify(entries, null, 2)}\n`, { sha, message: 'Update graph index' });
    } catch (err) {
      if (!reapply) throw err;
      const fresh = await readIndex();
      await client.putFile(INDEX_PATH, `${JSON.stringify(reapply(fresh.entries), null, 2)}\n`, { sha: fresh.sha, message: 'Update graph index' });
    }
  };

  const putJsonFile = async (repoPath, value, message) => {
    const existing = await client.getFile(repoPath);
    await client.putFile(repoPath, `${JSON.stringify(value, null, 2)}\n`, { sha: existing?.sha, message });
  };

  const findByHash = async (hash) => {
    const { entries } = await readIndex();
    return entries.find((entry) => entry.graphHash === hash) ?? null;
  };

  const upsert = (entries, repoMetadata) => [...entries.filter((entry) => entry.id !== repoMetadata.id), repoMetadata];

  return {
    /** @returns {Promise<{id, hash, metadata, points, notes}>} */
    async saveGraph(input) {
      try {
        const hash = hashGraph(input.params);
        const { entries, sha: indexSha } = await readIndex();
        const existing = entries.find((entry) => entry.graphHash === hash) ?? null;
        const id = existing?.id ?? randomUUID();
        const repoMetadata = toRepoMetadata(input, hash, id, existing);

        await putJsonFile(metadataPath(id), repoMetadata, `Save graph metadata ${id}`);
        await putJsonFile(pointsPath(id), input.points, `Save graph points ${id}`);
        await writeIndex(upsert(entries, repoMetadata), indexSha, (freshEntries) => upsert(freshEntries, repoMetadata));

        return toGraphObject(repoMetadata, input.points);
      } catch (err) {
        devWarn('saveGraph', err);
        return fallback.saveGraph(input);
      }
    },

    /** @returns {Promise<{id, hash, metadata, points, notes}|null>} */
    async loadGraph(hash) {
      try {
        const entry = await findByHash(hash);
        if (!entry) return fallback.loadGraph(hash);
        const pointsFile = await client.getFile(pointsPath(entry.id));
        const points = pointsFile ? JSON.parse(pointsFile.text) : [];
        return toGraphObject(entry, points);
      } catch (err) {
        devWarn('loadGraph', err);
        return fallback.loadGraph(hash);
      }
    },

    async graphExists(hash) {
      try {
        const entry = await findByHash(hash);
        return entry ? true : fallback.graphExists(hash);
      } catch (err) {
        devWarn('graphExists', err);
        return fallback.graphExists(hash);
      }
    },

    async deleteGraph(hash) {
      try {
        const { entries, sha: indexSha } = await readIndex();
        const entry = entries.find((e) => e.graphHash === hash) ?? null;
        if (!entry) return; // nothing to delete on GitHub — idempotent, matches the local store's own contract
        await client.deleteFile(metadataPath(entry.id));
        await client.deleteFile(pointsPath(entry.id));
        const remaining = entries.filter((e) => e.id !== entry.id);
        await writeIndex(remaining, indexSha, (freshEntries) => freshEntries.filter((e) => e.id !== entry.id));
      } catch (err) {
        devWarn('deleteGraph', err);
        await fallback.deleteGraph(hash);
      }
    },

    async renameGraph(hash, newTitle) {
      return this.updateGraphMetadata(hash, { title: newTitle });
    },

    /** @returns {Promise<object>} the updated metadata, in the same shape graphDatabase.js's own local store returns. */
    async updateGraphMetadata(hash, updates = {}) {
      try {
        const { entries, sha: indexSha } = await readIndex();
        const entry = entries.find((e) => e.graphHash === hash) ?? null;
        if (!entry) throw new Error(`No graph stored for hash: ${hash}`);
        const updated = {
          ...entry,
          title: updates.title !== undefined ? updates.title : entry.title,
          owner: updates.author !== undefined ? updates.author : entry.owner,
          colourHex: updates.graphColorHex !== undefined ? updates.graphColorHex : entry.colourHex,
          tags: updates.tags !== undefined ? updates.tags : entry.tags,
          notes: updates.notes !== undefined ? updates.notes : entry.notes,
          favourite: updates.favorite !== undefined ? updates.favorite : entry.favourite,
          visibility: updates.visibility !== undefined ? updates.visibility : entry.visibility,
          modifiedAt: new Date().toISOString(),
        };
        await putJsonFile(metadataPath(entry.id), updated, `Update graph metadata ${entry.id}`);
        await writeIndex(upsert(entries, updated), indexSha, (freshEntries) => upsert(freshEntries, updated));
        return fromRepoMetadata(updated);
      } catch (err) {
        devWarn('updateGraphMetadata', err);
        return fallback.updateGraphMetadata(hash, updates);
      }
    },

    /** @param {{sortBy?: string, order?: 'asc'|'desc'}} [options] */
    async listGraphs({ sortBy = 'createdAt', order = 'desc' } = {}) {
      try {
        const { entries } = await readIndex();
        const direction = order === 'asc' ? 1 : -1;
        const converted = entries.map(fromRepoMetadata);
        converted.sort((a, b) => {
          const left = a[sortBy] ?? '';
          const right = b[sortBy] ?? '';
          return left < right ? -direction : left > right ? direction : 0;
        });
        return converted;
      } catch (err) {
        devWarn('listGraphs', err);
        return fallback.listGraphs({ sortBy, order });
      }
    },

    /**
     * Same query shape as the local store's own searchGraphs (title/
     * codeSequence/angleA/angleB/baseLength/favorite/visibility/tags/
     * text) — `description`/`algorithmVersion` filters are accepted but
     * never match anything, since this repo's schema doesn't track either
     * field (see this module's own header comment). `text` matches
     * title/code/tags/owner/hash/notes all at once, same as the local
     * store — and, since database/index.json already holds every graph's
     * FULL notes text (not just a preview), this costs no extra I/O at
     * all, unlike the local store's own notes.md read.
     */
    async searchGraphs(query = {}, options = {}) {
      try {
        const { entries } = await readIndex();
        const contains = (haystack, needle) => (haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
        const matchesText = (entry, text) => (
          contains(entry.title, text) || contains(entry.code, text) || contains(entry.owner, text)
          || contains(entry.graphHash, text) || (entry.tags ?? []).some((tag) => contains(tag, text))
          || contains(entry.notes, text)
        );
        const filtered = entries.filter((entry) => {
          if (query.title && !contains(entry.title, query.title)) return false;
          if (query.codeSequence && !contains(entry.code, query.codeSequence)) return false;
          if (query.angleA !== undefined && entry.angleA !== Number(query.angleA)) return false;
          if (query.angleB !== undefined && entry.angleB !== Number(query.angleB)) return false;
          if (query.baseLength !== undefined && entry.baseLength !== Number(query.baseLength)) return false;
          if (query.favorite !== undefined && entry.favourite !== Boolean(query.favorite)) return false;
          if (query.visibility && entry.visibility !== query.visibility) return false;
          if (query.tags && query.tags.length > 0 && !query.tags.some((tag) => (entry.tags ?? []).includes(tag))) return false;
          if (query.text && !matchesText(entry, query.text)) return false;
          return true;
        });
        const direction = options.order === 'asc' ? 1 : -1;
        const sortBy = options.sortBy ?? 'createdAt';
        const converted = filtered.map(fromRepoMetadata);
        converted.sort((a, b) => {
          const left = a[sortBy] ?? '';
          const right = b[sortBy] ?? '';
          return left < right ? -direction : left > right ? direction : 0;
        });
        return converted;
      } catch (err) {
        devWarn('searchGraphs', err);
        return fallback.searchGraphs(query, options);
      }
    },
  };
};
