-- Indexes for the shared library's browse/search endpoints
-- (GraphRepository.queryGraphs). A plain B-tree index can't accelerate an
-- unanchored substring match ("contains", not "starts with") — pg_trgm's
-- GIN index is what actually lets searchGraphs' partial hash/code matches
-- (ILIKE '%...%') scale instead of falling back to a full table scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS graphs_hash_trgm_idx ON graphs USING gin (hash gin_trgm_ops);
CREATE INDEX IF NOT EXISTS graphs_sequence_text_trgm_idx ON graphs USING gin (sequence_text gin_trgm_ops);

-- created_at: backs both the newest/oldest sort and the createdAfter/
-- createdBefore date-range filter.
CREATE INDEX IF NOT EXISTS graphs_created_at_idx ON graphs(created_at DESC);
