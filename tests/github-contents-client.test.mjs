import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubContentsClient } from '../server/graphDatabase/githubContentsClient.js';

const encode = (text) => Buffer.from(text, 'utf8').toString('base64');

const buildClient = (fetchImpl) => createGithubContentsClient({
  token: 'fake-token', owner: 'tjhasan-dev', repo: 'illuminable-room-modeler', branch: 'main', fetchImpl,
});

test('getFile GETs the contents endpoint with the branch as ref and an Authorization header', async () => {
  let capturedUrl;
  let capturedOptions;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { ok: true, status: 200, json: async () => ({ content: encode('hello'), sha: 'abc123' }) };
  };
  const client = buildClient(fetchImpl);
  const result = await client.getFile('graphs/x/metadata.json');
  assert.equal(result.text, 'hello');
  assert.equal(result.sha, 'abc123');
  assert.match(capturedUrl, /\/repos\/tjhasan-dev\/illuminable-room-modeler\/contents\/graphs\/x\/metadata\.json\?ref=main$/);
  assert.equal(capturedOptions.headers.Authorization, 'Bearer fake-token');
});

test('getFile returns null (never throws) for a 404', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const client = buildClient(fetchImpl);
  assert.equal(await client.getFile('graphs/missing/metadata.json'), null);
});

test('getFile throws for a non-404 failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' });
  const client = buildClient(fetchImpl);
  await assert.rejects(() => client.getFile('graphs/x/metadata.json'), /500/);
});

test('putFile PUTs base64-encoded content with the branch, and omits sha when creating a new file', async () => {
  let capturedBody;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => ({ content: { sha: 'new-sha' } }) };
  };
  const client = buildClient(fetchImpl);
  const sha = await client.putFile('graphs/x/metadata.json', '{"a":1}', { message: 'Save graph' });
  assert.equal(sha, 'new-sha');
  assert.equal(capturedBody.content, encode('{"a":1}'));
  assert.equal(capturedBody.branch, 'main');
  assert.equal(capturedBody.message, 'Save graph');
  assert.ok(!('sha' in capturedBody));
});

test('putFile includes sha when updating an existing file', async () => {
  let capturedBody;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ content: { sha: 'updated-sha' } }) };
  };
  const client = buildClient(fetchImpl);
  await client.putFile('graphs/x/metadata.json', '{"a":2}', { sha: 'old-sha' });
  assert.equal(capturedBody.sha, 'old-sha');
});

test('putFile throws on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 422, statusText: 'Unprocessable Entity' });
  const client = buildClient(fetchImpl);
  await assert.rejects(() => client.putFile('graphs/x/metadata.json', '{}'), /422/);
});

test('deleteFile DELETEs with the provided sha', async () => {
  let capturedOptions;
  const fetchImpl = async (url, options) => { capturedOptions = options; return { ok: true, status: 200 }; };
  const client = buildClient(fetchImpl);
  await client.deleteFile('graphs/x/metadata.json', { sha: 'known-sha' });
  assert.equal(capturedOptions.method, 'DELETE');
  assert.equal(JSON.parse(capturedOptions.body).sha, 'known-sha');
});

test('deleteFile looks up the current sha via getFile when not provided', async () => {
  let getCalled = false;
  let deleteBody;
  const fetchImpl = async (url, options) => {
    if (!options || options.method === undefined) {
      getCalled = true;
      return { ok: true, status: 200, json: async () => ({ content: encode('x'), sha: 'looked-up-sha' }) };
    }
    deleteBody = JSON.parse(options.body);
    return { ok: true, status: 200 };
  };
  const client = buildClient(fetchImpl);
  await client.deleteFile('graphs/x/metadata.json');
  assert.equal(getCalled, true);
  assert.equal(deleteBody.sha, 'looked-up-sha');
});

test('deleteFile is a no-op (never throws) when the file is already gone', async () => {
  const fetchImpl = async (url, options) => {
    if (!options || options.method === undefined) return { ok: false, status: 404 };
    throw new Error('DELETE should never be called for a file that does not exist');
  };
  const client = buildClient(fetchImpl);
  await assert.doesNotReject(() => client.deleteFile('graphs/x/metadata.json'));
});

test('deleteFile throws for a non-ok, non-404 failure', async () => {
  const fetchImpl = async (url, options) => {
    if (!options || options.method === undefined) return { ok: true, status: 200, json: async () => ({ content: encode('x'), sha: 's' }) };
    return { ok: false, status: 500, statusText: 'Internal Server Error' };
  };
  const client = buildClient(fetchImpl);
  await assert.rejects(() => client.deleteFile('graphs/x/metadata.json'), /500/);
});
