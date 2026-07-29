-- graph_jobs: a persisted ledger of background exact-computation attempts
-- for a graph — the database equivalent of the browser's in-memory
-- backgroundExactWorker.js queue (see that module's own comment for the
-- live, in-process version of this same priority-queue concept). Unlike
-- that in-memory registry, rows here are never deleted on completion or
-- cancellation — this table is a history/audit log (useful for diagnosing
-- "why did this graph take so long" or "how many times was this
-- recomputed"), not a live scheduling structure a server process would
-- necessarily read from directly.
CREATE TABLE IF NOT EXISTS graph_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id UUID NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
  -- 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' — mirrors
  -- backgroundExactWorker.js's own job.status ('queued'/'running'), plus
  -- the terminal outcomes that module only expresses via its onResult
  -- callback today (points vs. error) rather than a stored state.
  status TEXT NOT NULL,
  -- Mirrors backgroundExactWorker.js's JOB_PRIORITY (lower = more urgent):
  -- VISIBLE=0, SELECTED=1, NEWLY_PLOTTED=2, HIDDEN=3.
  priority INTEGER NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS graph_jobs_graph_id_idx ON graph_jobs(graph_id);
CREATE INDEX IF NOT EXISTS graph_jobs_status_idx ON graph_jobs(status);
