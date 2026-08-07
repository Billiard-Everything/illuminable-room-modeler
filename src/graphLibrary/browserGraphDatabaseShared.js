// BrowserGraphDatabaseShared: small, storage-agnostic pieces the browser
// GraphDatabase store needs — mirrors server/graphDatabase/
// graphDatabaseShared.js's own role for the (now secondary) server-side
// file store, but written without any Node-only APIs (no `node:os`) so it
// can ship in the browser bundle.

/** Allowed values for a graph's `visibility` metadata field. Plain data — not an enforced permission system (no auth exists in this app). */
export const GRAPH_VISIBILITY = { PRIVATE: 'private', SHARED: 'shared', PUBLIC: 'public' };

const OWNER_STORAGE_KEY = 'illuminable-graph-owner-name';

/**
 * The `author`/"owner" a brand-new graph gets when nothing explicit was
 * passed. There is no OS-level user identity available in a browser (unlike
 * the server-side store's `os.userInfo()` fallback), so this instead reads
 * an optional, browser-stored display name — nothing edits it yet (no
 * settings UI exists for it today, matching this project's "don't build UI
 * ahead of a real need" convention), but the seam is here for one to set it
 * later without touching every save call site. Falls back to null.
 */
export const resolveDefaultOwner = (backend) => {
  try {
    return backend.getItem(OWNER_STORAGE_KEY) || null;
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

/** Stable, dependency-free id generator — prefers crypto.randomUUID() (available in every modern browser and Node 19+) but never throws if it's absent (older Node test runners). */
export const generateId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
