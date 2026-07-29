-- graphs: one row per unique graph identity. `hash` is the permanent
-- identifier every other layer (the browser app's in-memory GraphCache,
-- the background job queue, and this table itself) agrees on — see
-- src/anglePlot/graphHasher.js's hashGraph, the single function that
-- produces it. Every other column here is exactly the parameter set that
-- function hashes; keeping them as their own columns (not just folded into
-- the hash) is what lets a future query search or display *by* those
-- parameters, not only look a graph up when the hash is already known.
CREATE TABLE IF NOT EXISTS graphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hash TEXT NOT NULL UNIQUE,
  sequence_text TEXT NOT NULL,
  angle_a DOUBLE PRECISION NOT NULL,
  angle_b DOUBLE PRECISION NOT NULL,
  -- Kept as the raw Angle Step text, not a numeric column — see
  -- graphHasher.js's own comment on why "0.10" and "0.1" are different
  -- step *representations* worth distinguishing, not just different
  -- formatting of the same number.
  angle_step_input TEXT NOT NULL,
  base_length DOUBLE PRECISION NOT NULL,
  -- graphHasher.js's GRAPH_HASH_ALGORITHM_VERSION at the time this row's
  -- hash was computed. Stored (not just implied by the hash string itself)
  -- so a future migration that bumps the algorithm version can find and
  -- recompute every *old*-version row without re-parsing every hash.
  algorithm_version INTEGER NOT NULL,
  -- Nullable: no auth exists yet (see 0001_create_users.sql), so every
  -- graph is presently "unowned." ON DELETE SET NULL rather than CASCADE —
  -- deleting a user's account should not delete a graph other users may
  -- also depend on; only their *ownership* of it goes away.
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS graphs_owner_user_id_idx ON graphs(owner_user_id);
