// Sort values accepted by the local GraphDatabase's browse/search endpoints
// (server/api/app.js -> server/api/localGraphQueryParsing.js). Plain
// string-literal API contract values, not query logic — mirrors
// graphLibraryConstants.js's own GRAPH_SORT for the PostgreSQL-backed
// library, kept as a separate mirror since the two backing stores' sortable
// fields genuinely differ (this one has no download-count/last-used
// tracking — see localGraphQueryParsing.js's own comment).
export const LOCAL_GRAPH_SORT = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  RECENTLY_MODIFIED: 'recently_modified',
  TITLE_ASC: 'title_asc',
};

export const LOCAL_GRAPH_SORT_LABELS = {
  [LOCAL_GRAPH_SORT.NEWEST]: 'Newest',
  [LOCAL_GRAPH_SORT.OLDEST]: 'Oldest',
  [LOCAL_GRAPH_SORT.RECENTLY_MODIFIED]: 'Recently Modified',
  [LOCAL_GRAPH_SORT.TITLE_ASC]: 'Title (A–Z)',
};
