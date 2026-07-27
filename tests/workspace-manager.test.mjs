import assert from 'node:assert/strict';
import test from 'node:test';
import { saveWorkspace, loadWorkspace, clearWorkspace, WORKSPACE_SCHEMA_VERSION } from '../src/workspace/workspaceManager.js';

// A tiny in-memory stand-in for localStorage, injected via each function's
// optional `backend` parameter so these tests never touch real browser
// storage (which doesn't exist under Node's test runner anyway).
const createMemoryBackend = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
};

test('loadWorkspace returns null when nothing has been saved', () => {
  const backend = createMemoryBackend();
  assert.equal(loadWorkspace(backend), null);
});

test('saveWorkspace then loadWorkspace round-trips a plain snapshot', () => {
  const backend = createMemoryBackend();
  const snapshot = { theme: 'dark', zoom: 42, sequences: [{ id: 'seq-1', label: 'Graph 1' }] };
  assert.equal(saveWorkspace(snapshot, backend), true);
  const loaded = loadWorkspace(backend);
  assert.equal(loaded.theme, 'dark');
  assert.equal(loaded.zoom, 42);
  assert.deepEqual(loaded.sequences, [{ id: 'seq-1', label: 'Graph 1' }]);
});

test('saveWorkspace stamps the current schema version, overriding any caller-supplied one', () => {
  const backend = createMemoryBackend();
  saveWorkspace({ version: 999, theme: 'light' }, backend);
  const loaded = loadWorkspace(backend);
  assert.equal(loaded.version, WORKSPACE_SCHEMA_VERSION);
});

test('clearWorkspace makes a subsequent loadWorkspace return null again', () => {
  const backend = createMemoryBackend();
  saveWorkspace({ theme: 'dark' }, backend);
  assert.notEqual(loadWorkspace(backend), null);
  assert.equal(clearWorkspace(backend), true);
  assert.equal(loadWorkspace(backend), null);
});

test('loadWorkspace treats corrupt (non-JSON) stored data as no saved workspace', () => {
  const backend = createMemoryBackend();
  backend.setItem('unfolder-workspace', '{not valid json');
  assert.equal(loadWorkspace(backend), null);
});

test('loadWorkspace treats a stored JSON primitive (not an object) as no saved workspace', () => {
  const backend = createMemoryBackend();
  backend.setItem('unfolder-workspace', JSON.stringify(42));
  assert.equal(loadWorkspace(backend), null);
});

test('saveWorkspace never throws even if the backend itself throws (e.g. quota exceeded)', () => {
  const throwingBackend = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  assert.doesNotThrow(() => {
    const result = saveWorkspace({ theme: 'dark' }, throwingBackend);
    assert.equal(result, false);
  });
});

test('loadWorkspace never throws even if the backend itself throws', () => {
  const throwingBackend = {
    getItem: () => { throw new Error('SecurityError: storage disabled'); },
    setItem: () => {},
    removeItem: () => {},
  };
  assert.doesNotThrow(() => {
    const result = loadWorkspace(throwingBackend);
    assert.equal(result, null);
  });
});

test('clearWorkspace never throws even if the backend itself throws', () => {
  const throwingBackend = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => { throw new Error('SecurityError'); },
  };
  assert.doesNotThrow(() => {
    const result = clearWorkspace(throwingBackend);
    assert.equal(result, false);
  });
});

test('multiple independent backends do not interfere with each other', () => {
  const backendA = createMemoryBackend();
  const backendB = createMemoryBackend();
  saveWorkspace({ theme: 'dark' }, backendA);
  saveWorkspace({ theme: 'light' }, backendB);
  assert.equal(loadWorkspace(backendA).theme, 'dark');
  assert.equal(loadWorkspace(backendB).theme, 'light');
});
