import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPoolConfig } from '../server/db/pool.js';

test('buildPoolConfig uses DATABASE_URL as a connection string when set, with SSL on by default', () => {
  const config = buildPoolConfig({ DATABASE_URL: 'postgres://user:pass@host:5432/db' });
  assert.deepEqual(config, {
    connectionString: 'postgres://user:pass@host:5432/db',
    ssl: { rejectUnauthorized: false },
  });
});

test('buildPoolConfig falls back to individual PG* variables when DATABASE_URL is unset, with SSL off by default', () => {
  const config = buildPoolConfig({
    PGHOST: 'db.example.com', PGPORT: '5433', PGUSER: 'app', PGPASSWORD: 'secret', PGDATABASE: 'graphs',
  });
  assert.deepEqual(config, {
    host: 'db.example.com', port: 5433, user: 'app', password: 'secret', database: 'graphs', ssl: false,
  });
});

test('buildPoolConfig defaults host/port when neither DATABASE_URL nor PGHOST/PGPORT are set', () => {
  const config = buildPoolConfig({});
  assert.equal(config.host, 'localhost');
  assert.equal(config.port, 5432);
});

test('buildPoolConfig prefers DATABASE_URL over PG* variables when both are present', () => {
  const config = buildPoolConfig({ DATABASE_URL: 'postgres://a/b', PGHOST: 'ignored' });
  assert.deepEqual(config, { connectionString: 'postgres://a/b', ssl: { rejectUnauthorized: false } });
});

test('buildPoolConfig disables SSL on a DATABASE_URL connection when PGSSL=disable', () => {
  const config = buildPoolConfig({ DATABASE_URL: 'postgres://a/b', PGSSL: 'disable' });
  assert.deepEqual(config, { connectionString: 'postgres://a/b', ssl: false });
});

test('buildPoolConfig enables SSL on a discrete-field connection when PGSSL=require', () => {
  const config = buildPoolConfig({ PGHOST: 'db.example.com', PGSSL: 'require' });
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
});

test('buildPoolConfig leaves SSL off on a discrete-field connection for any other PGSSL value', () => {
  const config = buildPoolConfig({ PGHOST: 'db.example.com', PGSSL: 'whatever' });
  assert.equal(config.ssl, false);
});
