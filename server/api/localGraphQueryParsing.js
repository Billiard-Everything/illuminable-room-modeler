// Pure HTTP-query-string -> graphDatabase.js-options parsing for the local
// file-based GraphDatabase's own browse/search routes (GET /api/local-graphs,
// /api/local-graphs/search) — the local-store counterpart to queryParsing.js,
// kept as its own file rather than folded into that one because the two
// backing stores have genuinely different schemas (this one has title/
// notes/tags/favorite/visibility; the PostgreSQL-backed one has owner/
// download-count/algorithmVersion filtering) — sharing one file would mean
// either schema leaking into the other's option shape for no real reason.
//
// Deliberately no `recently_used`/`most_downloaded` sort here: the local
// GraphDatabase tracks neither (no download-count/last-accessed field in
// its metadata.json — see graphDatabase.js's own buildMetadata), so those
// two of queryParsing.js's four sorts have no local equivalent yet.

/**
 * Query-string `sort` values this API accepts, mapped to graphDatabase.js's
 * own `{sortBy, order}` shape (listGraphs/searchGraphs' own option
 * contract, left unchanged rather than taught a new enum-based shape).
 */
export const LOCAL_GRAPH_SORT = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  RECENTLY_MODIFIED: 'recently_modified',
  TITLE_ASC: 'title_asc',
};

const SORT_TO_OPTIONS = {
  [LOCAL_GRAPH_SORT.NEWEST]: { sortBy: 'createdAt', order: 'desc' },
  [LOCAL_GRAPH_SORT.OLDEST]: { sortBy: 'createdAt', order: 'asc' },
  [LOCAL_GRAPH_SORT.RECENTLY_MODIFIED]: { sortBy: 'modifiedAt', order: 'desc' },
  [LOCAL_GRAPH_SORT.TITLE_ASC]: { sortBy: 'title', order: 'asc' },
};

const DEFAULT_SORT_OPTIONS = SORT_TO_OPTIONS[LOCAL_GRAPH_SORT.NEWEST];

/**
 * Parses the sort/limit/offset/filter query params shared by both local
 * browse-style routes. An unrecognized `sort` value falls back to the
 * NEWEST default (same "never hard-fail over a typo'd sort param"
 * philosophy as queryParsing.js's own parseListOptions), rather than being
 * rejected.
 *
 * @returns {{sortBy: string, order: string, limit?: number, offset?: number, onlyFavorites?: boolean, visibility?: string}}
 */
export const parseLocalListOptions = (searchParams) => {
  const sort = searchParams.get('sort');
  const { sortBy, order } = (sort && SORT_TO_OPTIONS[sort]) || DEFAULT_SORT_OPTIONS;
  const options = { sortBy, order };

  const limit = searchParams.get('limit');
  if (limit !== null) options.limit = Number(limit);
  const offset = searchParams.get('offset');
  if (offset !== null) options.offset = Number(offset);

  return options;
};

/**
 * Parses GET /api/local-graphs/search's own search-field query params into
 * graphDatabase.js's searchGraphs' query shape. `code` (the public,
 * user-facing query param name, matching queryParsing.js's own convention)
 * maps to `codeSequence` (the local schema's own field name for it). `q`
 * is the Graph Database browser's one free-text search box — maps to
 * searchGraphs' own `text` field, which matches across title/code/tags/
 * notes/owner/hash all at once (see graphDatabase.js's own comment on why
 * that's a distinct concept from the exact-field filters below it).
 */
export const parseLocalSearchQuery = (searchParams) => {
  const query = {};
  if (searchParams.has('q')) query.text = searchParams.get('q');
  if (searchParams.has('title')) query.title = searchParams.get('title');
  if (searchParams.has('code')) query.codeSequence = searchParams.get('code');
  if (searchParams.has('angleA')) query.angleA = Number(searchParams.get('angleA'));
  if (searchParams.has('angleB')) query.angleB = Number(searchParams.get('angleB'));
  if (searchParams.has('baseLength')) query.baseLength = Number(searchParams.get('baseLength'));
  if (searchParams.get('favorite') === 'true') query.favorite = true;
  if (searchParams.has('visibility')) query.visibility = searchParams.get('visibility');
  if (searchParams.has('tags')) {
    // Comma-separated, matching how a plain query string represents a
    // list without repeating the same key (?tags=a,b) — mirrors this
    // app's own remoteGraphRepository.js/graphLibraryConstants.js
    // conventions elsewhere for simple, framework-free query encoding.
    query.tags = searchParams.get('tags').split(',').map((t) => t.trim()).filter(Boolean);
  }
  return query;
};
