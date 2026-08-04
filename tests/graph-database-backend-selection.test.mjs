// Tests for resolveDefaultGraphDatabase's own startup diagnostic — the ONE
// log line that answers "is the GitHub upload path even being called"
// before a single request comes in (see graphDatabase.js's own header
// comment on why a silently-working local fallback looks identical from
// the outside to "GitHub was never configured at all").
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDefaultGraphDatabase } from '../server/graphDatabase/graphDatabase.js';

const ENV_KEYS = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH'];

const withEnv = async (overrides, fn) => {
  const originals = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  }
};

const captureLogs = () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => { console.log = original; } };
};

test('with no GITHUB_* env vars, logs that GitHub storage is NOT configured and lists all three as missing', async () => {
  await withEnv({}, () => {
    const { lines, restore } = captureLogs();
    resolveDefaultGraphDatabase();
    restore();
    const line = lines.find((l) => l.includes('[graph-database]'));
    assert.ok(line, 'expected a [graph-database] startup log line');
    assert.match(line, /NOT configured/);
    assert.match(line, /GITHUB_TOKEN/);
    assert.match(line, /GITHUB_OWNER/);
    assert.match(line, /GITHUB_REPO/);
  });
});

test('with only some GITHUB_* env vars set, logs exactly which ones are still missing', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'o' }, () => {
    const { lines, restore } = captureLogs();
    resolveDefaultGraphDatabase();
    restore();
    const line = lines.find((l) => l.includes('[graph-database]'));
    assert.match(line, /NOT configured \(missing: GITHUB_REPO\)/);
  });
});

test('with all three required GITHUB_* env vars set, logs ENABLED with the resolved owner/repo/branch', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'tasmiahjh-hash', GITHUB_REPO: 'graph-database' }, () => {
    const { lines, restore } = captureLogs();
    resolveDefaultGraphDatabase();
    restore();
    const line = lines.find((l) => l.includes('[graph-database]'));
    assert.match(line, /ENABLED/);
    assert.match(line, /tasmiahjh-hash\/graph-database@main/);
    // Never logs the token value itself.
    assert.ok(!line.includes('GITHUB_TOKEN=t'), 'must never print the token value');
  });
});

test('GITHUB_BRANCH, when set, is used instead of the "main" default in the log line', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'develop' }, () => {
    const { lines, restore } = captureLogs();
    resolveDefaultGraphDatabase();
    restore();
    const line = lines.find((l) => l.includes('[graph-database]'));
    assert.match(line, /o\/r@develop/);
  });
});
