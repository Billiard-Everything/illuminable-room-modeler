// Shared HTTP-client helpers for this project's browser-side API clients
// (remoteGraphRepository.js talking to the PostgreSQL-backed shared
// library, localGraphDatabaseClient.js talking to the file-based
// GraphDatabase) — extracted here so neither module defines its own copy.
//
// Both API base URLs are read the same way (VITE_GRAPH_API_URL — the two
// clients talk to the SAME api/app.js process, just different route
// prefixes, so a single shared base URL is correct, not a coincidence).

// import.meta.env is Vite-injected and undefined under plain Node (e.g.
// these modules' own tests) — optional-chained throughout, matching
// workspaceManager.js's own established fix for the same gotcha.
export const apiBaseUrl = () => import.meta.env?.VITE_GRAPH_API_URL || 'http://localhost:8787';

export const devLog = (...args) => { if (import.meta.env?.DEV) console.log(...args); };
export const devWarn = (...args) => { if (import.meta.env?.DEV) console.warn(...args); };

export const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
