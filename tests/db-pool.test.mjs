import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPoolConfig } from '../server/db/pool.js';

test('buildPoolConfig uses DATABASE_URL as a connection string when set', () => {
  const config = buildPoolConfig({ DATABASE_URL: 'postgres://user:pass@host:5432/db' });
  assert.deepEqual(config, { connectionString: 'postgres://user:pass@host:5432/db' });
});

test('buildPoolConfig falls back to individual PG* variables when DATABASE_URL is unset', () => {
  const config = buildPoolConfig({
    PGHOST: 'db.example.com', PGPORT: '5433', PGUSER: 'app', PGPASSWORD: 'secret', PGDATABASE: 'graphs',
  });
  assert.deepEqual(config, {
    host: 'db.example.com', port: 5433, user: 'app', password: 'secret', database: 'graphs',
  });
});

test('buildPoolConfig defaults host/port when neither DATABASE_URL nor PGHOST/PGPORT are set', () => {
  const config = buildPoolConfig({});
  assert.equal(config.host, 'localhost');
  assert.equal(config.port, 5432);
});

test('buildPoolConfig prefers DATABASE_URL over PG* variables when both are present', () => {
  const config = buildPoolConfig({ DATABASE_URL: 'postgres://a/b', PGHOST: 'ignored' });
  assert.deepEqual(config, { connectionString: 'postgres://a/b' });
});
