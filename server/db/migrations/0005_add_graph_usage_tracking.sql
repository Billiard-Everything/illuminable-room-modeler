-- graphs: usage-tracking columns for the shared library's "most recently
-- used" and "most downloaded" sort options (see GraphRepository's
-- GRAPH_SORT and recordGraphAccess). Both start unset/zero and are only
-- ever touched by recordGraphAccess, called from the download route
-- (server/api/app.js) on a successful GET /api/graphs/:hash — never from
-- the upload path, since uploading a graph isn't the same as someone
-- browsing/using it, and never from the browse/search/list routes, which
-- return metadata only and must stay side-effect-free.
ALTER TABLE graphs
  ADD COLUMN IF NOT EXISTS download_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS graphs_download_count_idx ON graphs(download_count DESC);
CREATE INDEX IF NOT EXISTS graphs_last_accessed_at_idx ON graphs(last_accessed_at DESC);
