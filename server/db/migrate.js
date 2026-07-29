// Migration runner: applies server/db/migrations/*.sql files in filename
// order, tracking which ones have already run in a `schema_migrations`
// table so re-running this is always safe (already-applied files are
// skipped). Deliberately tiny and dependency-free rather than pulling in a
// migration framework — four tables don't need one, and a plain ordered
// list of .sql files is easy to read top-to-bottom as the schema's own
// history.
//
// `runMigrations` takes a `pool`-shaped object (anything with an async
// `query(text, params)`, exactly what pg.Pool and pg.Client both already
// provide) rather than reaching for db/pool.js's shared pool itself, so
// tests can pass a fully in-memory fake and verify the runner's own logic
// (order, skip-already-applied, tracking) without a real database — see
// migrate.test.mjs.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Filenames of every migration, in the order they must be applied. */
export const listMigrationFiles = (dir = MIGRATIONS_DIR) => readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();

/**
 * Applies every not-yet-applied migration in `dir`, in order, and records
 * each one in `schema_migrations` as it succeeds. Returns the filenames
 * actually applied this run (empty if the schema was already current).
 */
export const runMigrations = async (pool, dir = MIGRATIONS_DIR) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const appliedThisRun = [];
  for (const file of listMigrationFiles(dir)) {
    if (alreadyApplied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    appliedThisRun.push(file);
  }
  return appliedThisRun;
};

// CLI entry point: `node server/db/migrate.js`. Only runs when this file is
// executed directly (not when imported, e.g. by tests), and only then
// touches the real shared pool.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { getPool, closePool } = await import('./pool.js');
  const pool = await getPool();
  const applied = await runMigrations(pool);
  console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Schema already up to date.');
  await closePool();
}
