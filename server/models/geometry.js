// Geometry model: maps between a `graph_geometry` table row and the plain
// domain shape used elsewhere. Mirrors the { points, renderInfo } shape
// GraphCache already caches in-memory (see src/anglePlot/graphCache.js) —
// `points`/`pointCount`/`status`/`durationMs` here are exactly the fields
// that shape's `renderInfo` already carries, so a future stage swapping
// GraphCache's backing store for this table is a source change, not a
// shape change (see graph.js's own "Database extension point" comment).

/** @returns {{id, graphId, points, pointCount, status, durationMs, createdAt, updatedAt}} */
export const geometryRowToModel = (row) => ({
  id: row.id,
  graphId: row.graph_id,
  points: row.points,
  pointCount: row.point_count,
  status: row.status,
  durationMs: row.duration_ms,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
