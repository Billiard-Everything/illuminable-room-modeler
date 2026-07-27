// WorkspaceManager: the ONLY module that talks to browser storage for
// persisting/restoring the user's workspace (every graph card and its
// settings, plus the surrounding view state) across page reloads and
// browser restarts — no other file in this app should read or write
// localStorage/IndexedDB for this purpose. App.jsx builds a plain,
// JSON-serializable snapshot (see its own buildWorkspaceSnapshot) and
// hands it to saveWorkspace; on startup it calls loadWorkspace once and
// seeds every relevant piece of state from whatever comes back.
//
// Staged plan (mirrors graphCache.js's own staged design elsewhere in this
// app)
// -----------------------------------------------------------------------
// Stage 1 (this file): a single localStorage key, synchronous save/load,
// with debouncing left to the caller (see App.jsx's autosave effect) so
// this module stays a plain, un-opinionated read/write surface.
// Future stage (not implemented — explicit non-goal for now): swap the
// storage backend to IndexedDB (larger payloads, async access) or a
// backend database (cross-device sync). Every call site already only ever
// calls saveWorkspace/loadWorkspace/clearWorkspace, so that swap is
// entirely internal to this file — the `backend` parameter below (already
// injectable, defaulting to localStorage) is exactly the seam that change
// would use, and the three exported functions could become async with a
// mechanical (not structural) change to their callers.
//
// Versioning
// ------------
// Every saved payload carries a `version` field. loadWorkspace always runs
// the parsed payload through migrateWorkspace before returning it, so
// every caller only ever sees the current schema shape regardless of which
// version was actually on disk. A future schema change adds exactly one
// `if (migrated.version < N)` step to migrateWorkspace — never a change to
// how App.jsx (or anything else) reads the result.

const STORAGE_KEY = 'unfolder-workspace';

export const WORKSPACE_SCHEMA_VERSION = 1;

// Injectable purely so a future storage swap (or a test) can supply a
// different backend without changing any call site — see the module
// comment above.
const defaultBackend = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: (key) => window.localStorage.removeItem(key),
};

/**
 * Upgrades a parsed (but possibly older-version) workspace payload to the
 * current WORKSPACE_SCHEMA_VERSION shape, one version step at a time.
 * Nothing to migrate yet (version 1 is still the only version that has
 * ever existed) — this is where a future step goes:
 *
 *   if (migrated.version < 2) {
 *     migrated = { ...migrated, someNewField: SOME_DEFAULT, version: 2 };
 *   }
 */
const migrateWorkspace = (workspace) => {
  const migrated = workspace;
  return migrated;
};

/**
 * Persists a plain, JSON-serializable workspace snapshot. Never throws —
 * storage can fail for reasons entirely outside this app's control (quota
 * exceeded, private browsing, storage disabled by the browser/user), and a
 * failed autosave should never interrupt whatever the user was doing.
 *
 * @param {object} workspace - plain object; `version` is set here, callers
 *   never need to stamp it themselves.
 * @param {{getItem,setItem,removeItem}} [backend] - defaults to localStorage.
 * @returns {boolean} whether the save actually succeeded.
 */
export const saveWorkspace = (workspace, backend = defaultBackend) => {
  try {
    const payload = JSON.stringify({ ...workspace, version: WORKSPACE_SCHEMA_VERSION });
    backend.setItem(STORAGE_KEY, payload);
    return true;
  } catch (error) {
    if (import.meta.env?.DEV) console.warn('[WorkspaceManager] save failed (continuing without autosave for this change):', error);
    return false;
  }
};

/**
 * Loads and migrates the saved workspace, or returns null if there isn't
 * one — first visit, storage disabled/unavailable, or a corrupt/unreadable
 * saved payload all collapse to the same "nothing to restore" result, so
 * every caller can treat null as exactly "start with normal defaults".
 *
 * @param {{getItem,setItem,removeItem}} [backend] - defaults to localStorage.
 * @returns {object|null}
 */
export const loadWorkspace = (backend = defaultBackend) => {
  try {
    const raw = backend.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return migrateWorkspace(parsed);
  } catch (error) {
    if (import.meta.env?.DEV) console.warn('[WorkspaceManager] load failed (treating as no saved workspace):', error);
    return null;
  }
};

/**
 * Clears the saved workspace; the next loadWorkspace call reverts to
 * returning null (as if nothing had ever been saved). Not wired to any UI
 * yet (no "reset workspace" button exists), but kept as part of this
 * module's own surface rather than left for a caller to reinvent with a
 * raw removeItem call.
 *
 * @param {{getItem,setItem,removeItem}} [backend] - defaults to localStorage.
 * @returns {boolean} whether the clear actually succeeded.
 */
export const clearWorkspace = (backend = defaultBackend) => {
  try {
    backend.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    if (import.meta.env?.DEV) console.warn('[WorkspaceManager] clear failed:', error);
    return false;
  }
};
