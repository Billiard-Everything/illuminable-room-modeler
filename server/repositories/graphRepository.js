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
// Not wired into the browser app (see the task this file was built for:
// "set up PostgreSQL architecture, do NOT migrate functionality yet")
// -------------------------------------------------------------------------
// Nothing in src/** imports this file, and nothing here is called from the
// running app. This is architecture scaffolding for a future shared graph
// library server — a real Postgres connection isn't even reachable from a
// browser tab; a server process using this repository, sitting behind an
// API src/** would call over HTTP, is the piece that doesn't exist yet.
// When it does, GraphCache's own Stage 3 comment (src/anglePlot/graphCache.js)
// already describes the shape that integration takes: the browser's
// GraphCache.get/set interface stays the same, and only what's *behind* it
// changes to an async call into that future API.
//
// Every method takes a `hash` produced by src/anglePlot/graphHasher.js's
// hashGraph — the same permanent identity the in-memory GraphCache and the
// background job queue already use, so a graph's identity is never
// redefined a third way at this layer.

import { getPool } from '../db/pool.js';
import { hashGraph, GRAPH_HASH_ALGORITHM_VERSION } from '../../src/anglePlot/graphHasher.js';
import { graphRowToModel } from '../models/graph.js';
import { geometryRowToModel } from '../models/geometry.js';

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
