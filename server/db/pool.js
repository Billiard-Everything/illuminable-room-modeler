// Database layer: connection management for the shared graph library's
// PostgreSQL backend. This is the ONLY module in the whole project allowed
// to construct a database connection — every other server/** module reaches
// the database through this one's exported `query`, never by importing
// `pg` directly (see graphRepository.js's own module comment for the
// stronger rule that SQL text itself must live only in that one file).
//
// Why this exists at all right now
// -----------------------------------
// This project is currently a 100% client-side Vite/React app — there is
// no server process, no API route, nothing that runs Node in production.
// This module (and everything else under server/**) is architecture
// scaffolding for a *future* shared graph library: a server process that
// will eventually sit behind an API the browser app calls, backed by
// PostgreSQL, so an exact graph computed once is available to every user
// forever instead of only the browser tab that computed it. Nothing here
// is wired into src/** — see graphRepository.js's own comment for the full
// non-goals list. Building the module boundary now (rather than once an
// API server exists) is what keeps that future step from becoming a
// rewrite: GraphRepository's callers will only ever need to start calling
// it, not restructure how the database is reached.
//
// Lazy, single shared pool
// --------------------------
// The pool is constructed on first use, not at module load, so importing
// this file (or anything that imports it) never requires DATABASE_URL to
// be set — useful for tests, which inject their own fake pool into
// GraphRepository instead (see graphRepository.test.mjs) and never call
// getPool() at all.

let pg;
let pool = null;

// pg is required lazily (not statically imported) so this module can be
// imported — and its pure helper, buildPoolConfig, tested — even in an
// environment where the `pg` package isn't installed at all (e.g. a
// front-end-only checkout). Only actually calling getPool()/query() needs
// it present.
const loadPg = async () => {
  if (!pg) {
    pg = (await import('pg')).default;
  }
  return pg;
};

/**
 * Builds node-postgres's Pool config from environment variables. A pure
 * function (no I/O) so it's directly testable without a real database or
 * even the `pg` package installed.
 *
 * DATABASE_URL, if set, is used as-is (the standard `postgres://user:pass@host:port/db`
 * connection string). Otherwise falls back to the individual PG* variables
 * node-postgres itself already recognizes, applied explicitly here so this
 * module's behavior doesn't silently depend on undocumented library
 * defaults.
 */
export const buildPoolConfig = (env = process.env) => {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  return {
    host: env.PGHOST ?? 'localhost',
    port: env.PGPORT ? Number(env.PGPORT) : 5432,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
  };
};

/** Returns the shared pool, constructing it on first call. */
export const getPool = async () => {
  if (!pool) {
    const pgModule = await loadPg();
    pool = new pgModule.Pool(buildPoolConfig());
  }
  return pool;
};

/** Runs one query against the shared pool. `params` are positional ($1, $2, ...). */
export const query = async (text, params) => {
  const activePool = await getPool();
  return activePool.query(text, params);
};

/** Closes the shared pool (tests / graceful shutdown only — never called mid-request). */
export const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};
