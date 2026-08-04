// Tests for logGraphDatabaseStartup — the ONE startup diagnostic that
// answers "is the GitHub upload path even being called" before a single
// request comes in (see graphDatabase.js's own header comment on why a
// silently-working local fallback looks identical from the outside to
// "GitHub was never configured at all"). Prints exactly one of:
//   [graph-database] GitHub-backed storage ENABLED
//   [graph-database] GitHub-backed storage DISABLED
// — resolveDefaultGraphDatabase() decides which and records the facts;
// logGraphDatabaseStartup() is what actually prints them, callable
// independently (see server/api/start.js's own explicit call, in addition
// to this module's own import-time call) so the message is guaranteed to
// land in the same log window as "listening on port".
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDefaultGraphDatabase, logGraphDatabaseStartup } from '../server/graphDatabase/graphDatabase.js';

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

/** resolveDefaultGraphDatabase() records the facts logGraphDatabaseStartup() reads — every test calls both, in that order, matching how server/api/start.js itself uses them. */
const resolveAndLog = () => {
  resolveDefaultGraphDatabase();
  const { lines, restore } = captureLogs();
  logGraphDatabaseStartup();
  restore();
  return lines;
};

test('with no GITHUB_* env vars, prints exactly "[graph-database] GitHub-backed storage DISABLED"', async () => {
  await withEnv({}, () => {
    const lines = resolveAndLog();
    assert.equal(lines[0], '[graph-database] GitHub-backed storage DISABLED');
  });
});

test('DISABLED case lists every missing env var on the follow-up line', async () => {
  await withEnv({}, () => {
    const lines = resolveAndLog();
    assert.match(lines[1], /GITHUB_TOKEN/);
    assert.match(lines[1], /GITHUB_OWNER/);
    assert.match(lines[1], /GITHUB_REPO/);
  });
});

test('with only some GITHUB_* env vars set, lists exactly which ones are still missing', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'o' }, () => {
    const lines = resolveAndLog();
    assert.equal(lines[0], '[graph-database] GitHub-backed storage DISABLED');
    assert.match(lines[1], /missing env var\(s\): GITHUB_REPO$/);
  });
});

test('with all three required GITHUB_* env vars set, prints exactly "[graph-database] GitHub-backed storage ENABLED"', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'tasmiahjh-hash', GITHUB_REPO: 'graph-database' }, () => {
    const lines = resolveAndLog();
    assert.equal(lines[0], '[graph-database] GitHub-backed storage ENABLED');
  });
});

test('ENABLED case prints owner, repository, and branch on their own lines, defaulting branch to "main"', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'tasmiahjh-hash', GITHUB_REPO: 'graph-database' }, () => {
    const lines = resolveAndLog();
    assert.match(lines[1], /owner:\s+tasmiahjh-hash$/);
    assert.match(lines[2], /repository:\s+graph-database$/);
    assert.match(lines[3], /branch:\s+main$/);
  });
});

test('GITHUB_BRANCH, when set, is used instead of the "main" default', async () => {
  await withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_BRANCH: 'develop' }, () => {
    const lines = resolveAndLog();
    assert.match(lines[3], /branch:\s+develop$/);
  });
});

test('never prints the token value anywhere', async () => {
  await withEnv({ GITHUB_TOKEN: 'super-secret-token-value', GITHUB_OWNER: 'o', GITHUB_REPO: 'r' }, () => {
    const lines = resolveAndLog();
    for (const line of lines) assert.ok(!line.includes('super-secret-token-value'), `token leaked into: ${line}`);
  });
});
