// Sort values accepted by the shared library's browse/search endpoints
// (server/api/app.js -> GraphRepository.queryGraphs). These are plain
// string-literal API contract values, not query logic — the actual sort
// SQL lives entirely in server/repositories/graphRepository.js's own
// GRAPH_SORT/SORT_CLAUSES, which this project's server/** code can't be
// imported into a browser bundle (it pulls in `pg`, which needs Node-only
// sockets). Mirroring just the four literal strings the UI exposes here is
// the browser side of that one shared contract; if graphRepository.js's
// own GRAPH_SORT values ever change, these must be updated to match.
export const GRAPH_SORT = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  RECENTLY_USED: 'recently_used',
  MOST_DOWNLOADED: 'most_downloaded',
};

export const GRAPH_SORT_LABELS = {
  [GRAPH_SORT.NEWEST]: 'Newest',
  [GRAPH_SORT.OLDEST]: 'Oldest',
  [GRAPH_SORT.MOST_DOWNLOADED]: 'Most Downloaded',
  [GRAPH_SORT.RECENTLY_USED]: 'Recently Used',
};

/**
 * Whether `text` looks like a graphHasher.js hash (always starts
 * `alg<version>|`) rather than a billiards code sequence — used to decide
 * whether the Graph Library's single search box should search by hash or
 * by code, without needing two separate boxes for what are, in practice,
 * two very differently-shaped strings.
 */
export const looksLikeGraphHash = (text) => /^alg\d+\|/.test(text.trim());
