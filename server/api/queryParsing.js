// Pure HTTP-query-string -> GraphRepository-options parsing, kept separate
// from app.js so its route handlers stay thin (this task's own "keep all
// routing thin, business logic belongs in GraphRepository") — translating
// query-string text into the plain option objects queryGraphs already
// accepts isn't business logic itself, but it's still worth its own file
// so app.js's handlers read as "parse, call repository, respond" without
// this parsing cluttering them.

import { GRAPH_SORT } from '../repositories/graphRepository.js';

const VALID_SORTS = new Set(Object.values(GRAPH_SORT));

/**
 * Parses the pagination/sort/filter query params shared by every
 * browse-style route (GET /api/graphs, /search, /recent). An unrecognized
 * `sort` value is simply omitted (queryGraphs falls back to its own
 * NEWEST default) rather than rejected — a browse request should never
 * hard-fail over a typo'd sort param.
 */
export const parseListOptions = (searchParams) => {
  const options = {};

  const sort = searchParams.get('sort');
  if (sort && VALID_SORTS.has(sort)) options.sort = sort;

  const limit = searchParams.get('limit');
  if (limit !== null) options.limit = Number(limit);

  const offset = searchParams.get('offset');
  if (offset !== null) options.offset = Number(offset);

  const filters = {};
  if (searchParams.get('onlyExactGraphs') === 'true') filters.onlyExactGraphs = true;
  if (searchParams.has('ownerUserId')) filters.ownerUserId = searchParams.get('ownerUserId');
  if (searchParams.has('algorithmVersion')) filters.algorithmVersion = Number(searchParams.get('algorithmVersion'));
  if (searchParams.has('createdAfter')) filters.createdAfter = searchParams.get('createdAfter');
  if (searchParams.has('createdBefore')) filters.createdBefore = searchParams.get('createdBefore');
  // Extension point: a future tag/favorite/permission filter is one more
  // `if` here, added to `filters`, with its own matching branch in
  // buildGraphFilterClause (graphRepository.js) — nothing else changes.
  if (Object.keys(filters).length > 0) options.filters = filters;

  return options;
};

/**
 * Parses GET /api/graphs/search's own search-field query params into
 * queryGraphs' filter shape. `code` (the public, user-facing query param
 * name) maps to `sequenceText` (the internal/DB field name) — the same
 * indirection AnglePlotWindow.jsx's own UI already uses ("Code" in the
 * sidebar, `sequenceText` everywhere in the data model).
 */
export const parseSearchQuery = (searchParams) => {
  const query = {};
  if (searchParams.has('hash')) query.hash = searchParams.get('hash');
  if (searchParams.has('code')) query.sequenceText = searchParams.get('code');
  if (searchParams.has('angleA')) query.angleA = Number(searchParams.get('angleA'));
  if (searchParams.has('angleB')) query.angleB = Number(searchParams.get('angleB'));
  if (searchParams.has('baseLength')) query.baseLength = Number(searchParams.get('baseLength'));
  return query;
};
