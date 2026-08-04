// GraphDatabaseShared: small, storage-backend-agnostic pieces every
// GraphDatabase implementation needs (graphDatabase.js's own local/
// file-based store, githubGraphDatabase.js's GitHub-repo-backed store) —
// kept in their own leaf module (no dependency on either store) so both
// can import from here without graphDatabase.js and githubGraphDatabase.js
// ever needing to import from each other. graphDatabase.js constructs a
// GithubGraphDatabase (wrapping a local instance as its fallback — see
// that module's own header comment), which would be a circular import if
// githubGraphDatabase.js needed anything from graphDatabase.js in return;
// this file is what keeps that a one-way dependency instead.

import os from 'node:os';

/** Allowed values for a graph's `visibility` metadata field. Plain data — not an enforced permission system (no auth exists in this app — see either store's own non-goals). */
export const GRAPH_VISIBILITY = { PRIVATE: 'private', SHARED: 'shared', PUBLIC: 'public' };

/**
 * The `author`/"owner" a brand-new graph gets when nothing explicit was
 * passed — this app has no login system, so there's no real user identity
 * to record. An explicit GRAPH_DB_USERNAME env var wins if set; otherwise
 * this machine's own OS account name is a reasonable, zero-configuration
 * stand-in for "whoever computed this graph" — good enough for the Graph
 * Database browser's own "owner" card field without inventing an accounts
 * system for it. Falls back to null (rather than throwing) in a
 * sandboxed/containerized environment where os.userInfo() itself can throw
 * (e.g. Render's own containers, for the GitHub-backed store).
 */
export const resolveDefaultAuthor = () => {
  if (process.env.GRAPH_DB_USERNAME) return process.env.GRAPH_DB_USERNAME;
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
};

const NOTES_PREVIEW_LENGTH = 80;

/** A short, single-line excerpt of `notes` for card display without needing a second read of the full text during a listing. */
export const buildNotesPreview = (notes) => {
  const collapsed = (notes ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length <= NOTES_PREVIEW_LENGTH ? collapsed : `${collapsed.slice(0, NOTES_PREVIEW_LENGTH - 1)}…`;
};
