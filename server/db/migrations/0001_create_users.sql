-- users: minimal account scaffolding for the shared graph library. No
-- authentication, sessions, or accounts exist anywhere in this project yet
-- (that remains an explicit non-goal — see graphRepository.js) — this
-- table exists only so `graphs.owner_user_id` has somewhere to point once
-- a real auth system is added, without a later migration having to
-- retrofit the relationship in.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Opaque identifier from whatever future auth provider is chosen (e.g. an
  -- OAuth subject id). Nullable and unique so it can be backfilled later
  -- without constraining today's schema to one specific provider.
  external_id TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
