// GraphRepository: the ONLY module in this entire project allowed to
// execute SQL against the `graphs`/`graph_geometry`/`graph_jobs` tables.
// This is a hard rule, not just a convention: future code — an API route,
// a background worker, anything — must call a method here, never build or
// run a query of its own. Centralizing every query in one file is what
// makes the schema's actual contract auditable in one place, and what
// makes swapping *how* a query runs (connection pooling, read replicas,
// caching, a future ORM) a change entirely internal to this file.
//
// (server/db/migrate.js is the one structural exception: it runs schema-
// management SQL — CREATE TABLE, the schema_migrations bookkeeping — which
// is a deployment/ops concern, not the business-logic graph queries this
// rule is actually about.)
//
// Reached from the browser through server/api/** only (Phase 5)
// -------------------------------------------------------------------------
// A browser tab can't open a raw Postgres connection at all — TCP sockets
// aren't available to it — so server/api/app.js is the thin HTTP layer that
// src/anglePlot/remoteGraphRepository.js's fetch calls actually hit; that
// route handler is the *only* caller of this file from outside server/**.
// Nothing in src/** imports this file directly, and rendering code still
// never executes SQL, exactly as this module's own header rule requires —
// it just now has exactly one caller (the API layer) instead of zero.
// GraphCache's own Stage 3 comment (src/anglePlot/graphCache.js) describes
// the browser-side shape this integration takes: GraphCache.get/set stays
// the same interface, with a remote lookup/upload now sitting behind a
// GraphCache miss instead of the whole feature not existing yet.
//
// Every method takes a `hash` produced by src/anglePlot/graphHasher.js's
// hashGraph — the same permanent identity the in-memory GraphCache and the
// background job queue already use, so a graph's identity is never
// redefined a third way at this layer.

import { getPool } from '../db/pool.js';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../../src/anglePlot/graphHasher.js';
import { GRAPH_STATUS } from '../../src/anglePlot/graphStatus.js';
import { graphRowToModel, graphMetadataRowToModel } from '../models/graph.js';
import { geometryRowToModel } from '../models/geometry.js';

// Shared graph library (Phase 6): browsing, search, sort, and filter over
// every stored graph's *metadata* — never geometry (see queryGraphs' own
// comment). One sort enum, one filter-clause builder, and one underlying
// query (queryGraphs) back every listing method below
// (listGraphs/searchGraphs/listGraphsByUser/listRecentGraphs/
// listPopularGraphs/getGraphMetadata) so there is exactly one place this
// SQL is ever written, not five.

/** Sort orders queryGraphs accepts — see SORT_CLAUSES for what each maps to. */
export const GRAPH_SORT = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  RECENTLY_COMPUTED: 'recently_computed',
  RECENTLY_USED: 'recently_used',
  MOST_DOWNLOADED: 'most_downloaded',
};

// Whitelisted, never built from user input directly — a sort value that
// isn't a real key here falls back to NEWEST (see queryGraphs) rather than
// ever being interpolated into ORDER BY.
const SORT_CLAUSES = {
  [GRAPH_SORT.NEWEST]: 'g.created_at DESC',
  [GRAPH_SORT.OLDEST]: 'g.created_at ASC',
  // A graph's geometry can (in principle — see Stage 2/refinement notes
  // elsewhere in this codebase) be recomputed after the graph row itself
  // was created, so "recently computed" reads graph_geometry's own
  // updated_at, not the graph row's.
  [GRAPH_SORT.RECENTLY_COMPUTED]: 'gg.updated_at DESC NULLS LAST',
  [GRAPH_SORT.RECENTLY_USED]: 'g.last_accessed_at DESC NULLS LAST',
  [GRAPH_SORT.MOST_DOWNLOADED]: 'g.download_count DESC',
};

const DEFAULT_LIST_LIMIT = 50;
// Hard cap regardless of what a caller (ultimately, an HTTP query string)
// asks for, so a single browse/search request can never turn into an
// unbounded table scan's worth of rows serialized into one response.
const MAX_LIST_LIMIT = 200;

// graphs LEFT JOIN graph_geometry (not INNER — see graphMetadataRowToModel's
// own comment): a graph without geometry yet still needs to appear in a
// listing, just reporting hasExactGeometry: false, rather than vanishing
// from it entirely the way getGraphWithGeometry's own INNER JOIN
// deliberately does for its different (single-graph, geometry-required)
// use case.
const METADATA_SELECT = `
  SELECT
    g.hash, g.sequence_text, g.angle_a, g.angle_b, g.angle_step_input, g.base_length,
    g.algorithm_version, g.owner_user_id, g.created_at, g.updated_at,
    g.download_count, g.last_accessed_at,
    gg.point_count, gg.updated_at AS geometry_updated_at,
    (gg.id IS NOT NULL) AS has_exact_geometry
  FROM graphs g
  LEFT JOIN graph_geometry gg ON gg.graph_id = g.id
`;

/**
 * Builds the WHERE clause and positional params for every filter
 * queryGraphs supports — the one place this SQL is written. Extension
 * point for future filters (tags, favorites, ownership/permission scopes):
 * each becomes one more `if` below, appended to the same clauses/params
 * array; nothing about queryGraphs' own call sites needs to change.
 *
 * hash/sequenceText are partial (ILIKE '%...%') — see this phase's own
 * "search should support partial matches where appropriate." Numeric
 * fields (angleA/angleB/baseLength) and identifiers (ownerUserId,
 * algorithmVersion) are exact matches; a future min/max range filter for
 * the numeric fields would add its own `angleAMin`/`angleAMax`-style
 * branches here without touching the exact-match ones.
 */
const buildGraphFilterClause = (filters = {}) => {
  const clauses = [];
  const params = [];
  const push = (column, operator, value) => {
    params.push(value);
    clauses.push(`${column} ${operator} $${params.length}`);
  };

  // hashExact is used by getGraphMetadata (a single, known hash) so it
  // never pays for (or risks a false-positive substring match from) an
  // ILIKE scan the way the free-text search field below does.
  if (filters.hashExact) push('g.hash', '=', filters.hashExact);
  else if (filters.hash) push('g.hash', 'ILIKE', `%${filters.hash}%`);
  if (filters.sequenceText) push('g.sequence_text', 'ILIKE', `%${filters.sequenceText}%`);
  if (filters.angleA !== undefined) push('g.angle_a', '=', filters.angleA);
  if (filters.angleB !== undefined) push('g.angle_b', '=', filters.angleB);
  if (filters.baseLength !== undefined) push('g.base_length', '=', filters.baseLength);
  if (filters.ownerUserId) push('g.owner_user_id', '=', filters.ownerUserId);
  if (filters.algorithmVersion !== undefined) push('g.algorithm_version', '=', filters.algorithmVersion);
  if (filters.createdAfter) push('g.created_at', '>=', filters.createdAfter);
  if (filters.createdBefore) push('g.created_at', '<=', filters.createdBefore);
  if (filters.onlyExactGraphs) clauses.push('gg.id IS NOT NULL');

  return { whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

/**
 * Builds a GraphRepository bound to `pool` (anything with an async
 * `query(text, params)` — a real pg.Pool, or a fake for tests; see
 * graphRepository.test.mjs). A factory rather than a module-level
 * singleton so tests never need a real database connection to exercise
 * this file's own query-building logic.
 */
export const createGraphRepository = (pool) => ({
  /** The graph with this hash, or null if it's never been seen before. */
  async findByHash(hash) {
    const { rows } = await pool.query('SELECT * FROM graphs WHERE hash = $1', [hash]);
    return rows[0] ? graphRowToModel(rows[0]) : null;
  },

  /**
   * Inserts a graph for `params` if its hash has never been seen, or
   * returns the existing row unchanged otherwise (the permanent identity
   * is content-derived — there is nothing to "update" about an existing
   * graph's own params, only its updated_at bookkeeping).
   */
  async upsertGraph({ params, ownerUserId = null, algorithmVersion = GRAPH_HASH_ALGORITHM_VERSION }) {
    const hash = hashGraph(params);
    const { rows } = await pool.query(
      `INSERT INTO graphs (hash, sequence_text, angle_a, angle_b, angle_step_input, base_length, algorithm_version, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hash) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [hash, params.sequenceText, params.angleA, params.angleB, params.angleStepInput, params.baseLength, algorithmVersion, ownerUserId],
    );
    return graphRowToModel(rows[0]);
  },

  /** The current stored geometry for a graph, or null if none has been computed yet. */
  async getGeometry(graphId) {
    const { rows } = await pool.query('SELECT * FROM graph_geometry WHERE graph_id = $1', [graphId]);
    return rows[0] ? geometryRowToModel(rows[0]) : null;
  },

  /**
   * Replaces (or creates) a graph's stored geometry — one row per graph
   * (see the graph_geometry migration's own comment on why this isn't a
   * history table).
   */
  async saveGeometry(graphId, { points, status, durationMs = null }) {
    const { rows } = await pool.query(
      `INSERT INTO graph_geometry (graph_id, points, point_count, status, duration_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (graph_id) DO UPDATE SET
         points = $2, point_count = $3, status = $4, duration_ms = $5, updated_at = now()
       RETURNING *`,
      [graphId, JSON.stringify(points), points.length, status, durationMs],
    );
    return geometryRowToModel(rows[0]);
  },

  /**
   * Whether a graph with this hash has ever been stored — no geometry, no
   * row contents, just existence. Used by the upload pipeline's own
   * pre-check (see uploadExactGraphIfMissing) and available to any future
   * caller that only needs a yes/no answer without paying for a full row
   * fetch.
   */
  async graphExists(hash) {
    const { rows } = await pool.query('SELECT 1 FROM graphs WHERE hash = $1', [hash]);
    return rows.length > 0;
  },

  /**
   * The download pipeline's one call: graph *and* its geometry in a single
   * round trip (an INNER JOIN), rather than findByHash followed by a
   * separate getGeometry — avoiding the unnecessary second database call
   * this task explicitly asks to avoid. The INNER JOIN also means a graph
   * row that somehow exists without geometry yet (shouldn't normally
   * happen — see saveGeometry/uploadExactGraphIfMissing, which always
   * write both together) is correctly treated as "no exact graph
   * available" rather than a partial/broken result.
   *
   * @returns {{graph, geometry}|null}
   */
  async getGraphWithGeometry(hash) {
    const { rows } = await pool.query(
      `SELECT
         g.*,
         gg.id AS geometry_id, gg.points, gg.point_count, gg.status AS geometry_status,
         gg.duration_ms, gg.created_at AS geometry_created_at, gg.updated_at AS geometry_updated_at
       FROM graphs g
       JOIN graph_geometry gg ON gg.graph_id = g.id
       WHERE g.hash = $1`,
      [hash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      graph: graphRowToModel(row),
      geometry: {
        id: row.geometry_id, graphId: row.id, points: row.points, pointCount: row.point_count,
        status: row.geometry_status, durationMs: row.duration_ms,
        createdAt: row.geometry_created_at, updatedAt: row.geometry_updated_at,
      },
    };
  },

  /**
   * The upload pipeline's one call: stores a freshly-computed exact graph
   * only if this hash has never been stored before ("duplicate uploads
   * never occur" — see this task's own test list). Graph metadata and
   * geometry are saved together, since a graph row is never meant to exist
   * here without its geometry (see getGraphWithGeometry's own comment) —
   * there is no reason a caller would ever want one without the other.
   *
   * @returns {{uploaded: boolean, graph?, geometry?}} `uploaded` is false
   *   (with no graph/geometry) when the hash already existed — the caller
   *   (see AnglePlotWindow.jsx) treats this exactly the same as a
   *   successful upload: either way, the shared library now has it.
   */
  async uploadExactGraphIfMissing({ params, algorithmVersion = GRAPH_HASH_ALGORITHM_VERSION, ownerUserId = null, points, durationMs = null }) {
    const hash = hashGraph(params);
    if (await this.graphExists(hash)) return { uploaded: false };
    const graph = await this.upsertGraph({ params, ownerUserId, algorithmVersion });
    const geometry = await this.saveGeometry(graph.id, { points, status: GRAPH_STATUS.EXACT, durationMs });
    return { uploaded: true, graph, geometry };
  },

  // --- Shared graph library: browse, search, sort, filter (Phase 6) ------

  /**
   * The one query every listing/search method below delegates to — see
   * buildGraphFilterClause and SORT_CLAUSES for the filter/sort vocabulary
   * this accepts. Always returns metadata only (graphMetadataRowToModel),
   * never geometry, and always paginated (limit/offset), so a caller can
   * never accidentally trigger an unbounded scan-and-serialize of the
   * entire library.
   *
   * @param {object} [options]
   * @param {object} [options.filters] - see buildGraphFilterClause.
   * @param {string} [options.sort] - one of GRAPH_SORT; defaults to NEWEST.
   * @param {number} [options.limit] - defaults to DEFAULT_LIST_LIMIT, capped at MAX_LIST_LIMIT.
   * @param {number} [options.offset] - defaults to 0.
   */
  async queryGraphs({ filters = {}, sort = GRAPH_SORT.NEWEST, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const { whereSql, params } = buildGraphFilterClause(filters);
    const orderBySql = SORT_CLAUSES[sort] ?? SORT_CLAUSES[GRAPH_SORT.NEWEST];
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const { rows } = await pool.query(
      `${METADATA_SELECT} ${whereSql} ORDER BY ${orderBySql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, safeOffset],
    );
    return rows.map(graphMetadataRowToModel);
  },

  /** Every stored graph's metadata, optionally filtered/sorted/paginated — the shared library's general browse call. */
  async listGraphs(options = {}) {
    return this.queryGraphs(options);
  },

  /**
   * Free-text/exact search over the library. `query` supplies the
   * searchable fields (hash, sequenceText, angleA, angleB, baseLength —
   * see buildGraphFilterClause for which are partial vs. exact matches);
   * `options` supplies sort/pagination/additional filters exactly like
   * listGraphs, layered on top of `query`.
   */
  async searchGraphs(query = {}, options = {}) {
    return this.queryGraphs({ ...options, filters: { ...query, ...options.filters } });
  },

  /** Every graph owned by a given user — future-compatible: no auth exists yet, but the column/filter already does. */
  async listGraphsByUser(ownerUserId, options = {}) {
    return this.queryGraphs({ ...options, filters: { ...options.filters, ownerUserId } });
  },

  /** The newest graphs in the library — queryGraphs' own default sort, exposed as its own named call per this phase's own API examples. */
  async listRecentGraphs(options = {}) {
    return this.queryGraphs({ ...options, sort: options.sort ?? GRAPH_SORT.NEWEST });
  },

  /** The most-downloaded graphs in the library. */
  async listPopularGraphs(options = {}) {
    return this.queryGraphs({ ...options, sort: options.sort ?? GRAPH_SORT.MOST_DOWNLOADED });
  },

  /**
   * One graph's metadata by its exact hash — no geometry (see
   * getGraphWithGeometry for that). Reuses queryGraphs' own filter/mapping
   * logic (via the exact-match `hashExact` filter) rather than writing a
   * separate SELECT, so this and every listing method stay in sync by
   * construction.
   */
  async getGraphMetadata(hash) {
    const results = await this.queryGraphs({ filters: { hashExact: hash }, limit: 1 });
    return results[0] ?? null;
  },

  /**
   * Records that a graph was downloaded/used — called from the download
   * route (server/api/app.js) on a successful GET /api/graphs/:hash, never
   * from browsing/search/upload. Backs the RECENTLY_USED and
   * MOST_DOWNLOADED sort orders.
   */
  async recordGraphAccess(hash) {
    await pool.query(
      'UPDATE graphs SET download_count = download_count + 1, last_accessed_at = now() WHERE hash = $1',
      [hash],
    );
  },

  /** Records a new background job request for a graph, in 'queued' status. */
  async createJob({ graphId, priority }) {
    const { rows } = await pool.query(
      `INSERT INTO graph_jobs (graph_id, status, priority) VALUES ($1, 'queued', $2) RETURNING *`,
      [graphId, priority],
    );
    return rows[0];
  },

  /** Updates a job's status and (optionally) its started/finished timestamps or error. */
  async updateJobStatus(jobId, { status, startedAt = null, finishedAt = null, errorMessage = null }) {
    const { rows } = await pool.query(
      `UPDATE graph_jobs SET
         status = $2,
         started_at = COALESCE($3, started_at),
         finished_at = COALESCE($4, finished_at),
         error_message = $5
       WHERE id = $1
       RETURNING *`,
      [jobId, status, startedAt, finishedAt, errorMessage],
    );
    return rows[0] ?? null;
  },
});

let sharedRepository = null;

/** The repository bound to the real shared pool (server/db/pool.js). Lazy, since obtaining the pool is async. */
export const getGraphRepository = async () => {
  if (!sharedRepository) sharedRepository = createGraphRepository(await getPool());
  return sharedRepository;
};
