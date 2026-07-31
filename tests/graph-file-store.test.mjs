import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveLibraryDir, graphDirName, graphDirPath, hashToDirSegment, atomicWriteFile, atomicWriteJson,
  readJsonIfExists, readTextIfExists, pathExists, ensureDir, removeDir, listGraphDirs,
} from '../server/graphDatabase/graphFileStore.js';

let tempDir;
test.beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-file-store-test-'));
});
test.afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('resolveLibraryDir prefers an explicit baseDir over the env var and default', () => {
  const original = process.env.GRAPH_LIBRARY_DIR;
  process.env.GRAPH_LIBRARY_DIR = '/env/dir';
  try {
    assert.equal(resolveLibraryDir('/explicit/dir'), '/explicit/dir');
  } finally {
    if (original === undefined) delete process.env.GRAPH_LIBRARY_DIR; else process.env.GRAPH_LIBRARY_DIR = original;
  }
});

test('resolveLibraryDir falls back to GRAPH_LIBRARY_DIR, then the default ./GraphLibrary', () => {
  const original = process.env.GRAPH_LIBRARY_DIR;
  process.env.GRAPH_LIBRARY_DIR = '/env/dir';
  try {
    assert.equal(resolveLibraryDir(), '/env/dir');
  } finally {
    if (original === undefined) delete process.env.GRAPH_LIBRARY_DIR; else process.env.GRAPH_LIBRARY_DIR = original;
  }
  delete process.env.GRAPH_LIBRARY_DIR;
  assert.ok(resolveLibraryDir().endsWith('GraphLibrary'));
});

test('hashToDirSegment is a deterministic, filesystem-safe digest (no |, (, ), or other path-illegal characters)', () => {
  const hash = 'alg1|code(3 1 7 2 6 2 8 2 4 2)|a(15)|b(50)|step(0.1)|len(90)';
  const digest = hashToDirSegment(hash);
  assert.equal(digest, hashToDirSegment(hash), 'must be deterministic for the same input');
  assert.match(digest, /^[0-9a-f]+$/, 'must be plain hex — safe on every platform, including Windows');
});

test('hashToDirSegment produces different digests for different hashes', () => {
  assert.notEqual(hashToDirSegment('hash-a'), hashToDirSegment('hash-b'));
});

test('graphDirName/graphDirPath name the directory from the hash\'s digest, not the raw hash', () => {
  const hash = 'alg1|code(x)|a(15)|b(50)|step(0.1)|len(90)';
  assert.equal(graphDirName(hash), `graph_${hashToDirSegment(hash)}`);
  assert.equal(graphDirPath('/lib', hash), path.join('/lib', `graph_${hashToDirSegment(hash)}`));
});

test('atomicWriteFile writes text that can be read back exactly', async () => {
  const filePath = path.join(tempDir, 'notes.md');
  await atomicWriteFile(filePath, '# Hello\nSome notes.');
  assert.equal(await fs.readFile(filePath, 'utf8'), '# Hello\nSome notes.');
});

test('atomicWriteFile overwrites an existing file cleanly, leaving no leftover temp files', async () => {
  const filePath = path.join(tempDir, 'notes.md');
  await atomicWriteFile(filePath, 'first');
  await atomicWriteFile(filePath, 'second');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'second');
  const entries = await fs.readdir(tempDir);
  assert.deepEqual(entries, ['notes.md']);
});

test('atomicWriteJson writes pretty-printed JSON that readJsonIfExists parses back to the same value', async () => {
  const filePath = path.join(tempDir, 'metadata.json');
  const value = { hash: 'abc', tags: ['a', 'b'], favorite: true };
  await atomicWriteJson(filePath, value);
  assert.deepEqual(await readJsonIfExists(filePath), value);
});

test('readJsonIfExists returns undefined for a missing file instead of throwing', async () => {
  assert.equal(await readJsonIfExists(path.join(tempDir, 'missing.json')), undefined);
});

test('readTextIfExists returns the default value for a missing file', async () => {
  assert.equal(await readTextIfExists(path.join(tempDir, 'missing.md'), 'default text'), 'default text');
});

test('readTextIfExists returns the file content when it exists', async () => {
  const filePath = path.join(tempDir, 'notes.md');
  await fs.writeFile(filePath, 'real notes', 'utf8');
  assert.equal(await readTextIfExists(filePath, 'default'), 'real notes');
});

test('pathExists is true for an existing path and false for a missing one', async () => {
  assert.equal(await pathExists(tempDir), true);
  assert.equal(await pathExists(path.join(tempDir, 'nope')), false);
});

test('ensureDir creates nested directories', async () => {
  const nested = path.join(tempDir, 'a', 'b', 'c');
  await ensureDir(nested);
  assert.equal(await pathExists(nested), true);
});

test('removeDir deletes a directory and everything in it', async () => {
  const dir = path.join(tempDir, 'graph_abc');
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, 'metadata.json'), '{}', 'utf8');
  await removeDir(dir);
  assert.equal(await pathExists(dir), false);
});

test('removeDir is a no-op (never throws) for a directory that never existed', async () => {
  await assert.doesNotReject(() => removeDir(path.join(tempDir, 'never-existed')));
});

test('listGraphDirs returns [] for a library directory that does not exist yet', async () => {
  assert.deepEqual(await listGraphDirs(path.join(tempDir, 'does-not-exist')), []);
});

test('listGraphDirs finds every graph_ directory as a full path', async () => {
  await ensureDir(path.join(tempDir, 'graph_aaa'));
  await ensureDir(path.join(tempDir, 'graph_bbb'));
  const dirs = await listGraphDirs(tempDir);
  assert.deepEqual(dirs.sort(), [path.join(tempDir, 'graph_aaa'), path.join(tempDir, 'graph_bbb')].sort());
});

test('listGraphDirs ignores non-directory entries and directories not prefixed graph_', async () => {
  await ensureDir(path.join(tempDir, 'graph_real'));
  await ensureDir(path.join(tempDir, 'not-a-graph-dir'));
  await fs.writeFile(path.join(tempDir, 'graph_looks_like_a_file.txt'), 'x', 'utf8');
  const dirs = await listGraphDirs(tempDir);
  assert.deepEqual(dirs, [path.join(tempDir, 'graph_real')]);
});
