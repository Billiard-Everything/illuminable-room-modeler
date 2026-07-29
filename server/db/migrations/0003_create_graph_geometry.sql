-- graph_geometry: the computed points for a graph — the database
-- equivalent of GraphCache's own { points, renderInfo } cache entry (see
-- src/anglePlot/graphCache.js's Stage 1 comment, and its own Stage 3 note
-- that a persistent backend would sit behind the exact same get/set shape).
--
-- One row per graph for now (UNIQUE graph_id), matching that same Stage-1
-- simplification: this table's row *is* the current geometry, not a
-- history of every geometry ever computed for it. A future refinement
-- stage (Stage 2 in graphCache.js's own staged plan — screen-space
-- progressive detail) would be the natural point to loosen this to
-- multiple rows per graph (e.g. an added `lod` column), without changing
-- anything about how a *single* current-geometry row is read or written.
CREATE TABLE IF NOT EXISTS graph_geometry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id UUID NOT NULL UNIQUE REFERENCES graphs(id) ON DELETE CASCADE,
  -- The plain [{a, b}, ...] point array, stored as-is — mirrors
  -- GraphCache's own choice to cache geometry, never a rendered image, so
  -- it can be redrawn at any scale/theme/DPI later.
  points JSONB NOT NULL,
  -- Denormalized from points for cheap display (row counts, list views)
  -- without parsing the jsonb column.
  point_count INTEGER NOT NULL,
  -- Mirrors src/anglePlot/graphStatus.js's GRAPH_STATUS ('preview' |
  -- 'computing' | 'exact') as a plain text column — this table is only
  -- meaningful once a graph reaches 'exact', but the column isn't
  -- constrained to that value so an in-progress upsert can still be
  -- represented if a future stage ever wants one.
  status TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
