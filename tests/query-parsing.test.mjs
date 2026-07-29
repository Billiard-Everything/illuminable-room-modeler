import assert from 'node:assert/strict';
import test from 'node:test';
import { parseListOptions, parseSearchQuery } from '../server/api/queryParsing.js';
import { GRAPH_SORT } from '../server/repositories/graphRepository.js';

const sp = (query) => new URLSearchParams(query);

test('parseListOptions returns an empty options object for an empty query string', () => {
  assert.deepEqual(parseListOptions(sp('')), {});
});

test('parseListOptions accepts a recognized sort value', () => {
  assert.deepEqual(parseListOptions(sp({ sort: GRAPH_SORT.OLDEST })), { sort: GRAPH_SORT.OLDEST });
});

test('parseListOptions omits an unrecognized sort value rather than passing it through', () => {
  const options = parseListOptions(sp({ sort: 'not-a-real-sort' }));
  assert.ok(!('sort' in options));
});

test('parseListOptions parses limit/offset as numbers', () => {
  assert.deepEqual(parseListOptions(sp({ limit: '10', offset: '20' })), { limit: 10, offset: 20 });
});

test('parseListOptions parses onlyExactGraphs only when the value is literally "true"', () => {
  assert.deepEqual(parseListOptions(sp({ onlyExactGraphs: 'true' })), { filters: { onlyExactGraphs: true } });
  assert.deepEqual(parseListOptions(sp({ onlyExactGraphs: 'false' })), {});
  assert.deepEqual(parseListOptions(sp({ onlyExactGraphs: 'yes' })), {});
});

test('parseListOptions parses ownerUserId, algorithmVersion, and a createdAfter/createdBefore date range into filters', () => {
  const options = parseListOptions(sp({
    ownerUserId: 'user-1', algorithmVersion: '2', createdAfter: '2026-01-01', createdBefore: '2026-02-01',
  }));
  assert.deepEqual(options.filters, {
    ownerUserId: 'user-1', algorithmVersion: 2, createdAfter: '2026-01-01', createdBefore: '2026-02-01',
  });
});

test('parseListOptions combines sort, pagination, and filters together', () => {
  const options = parseListOptions(sp({ sort: GRAPH_SORT.MOST_DOWNLOADED, limit: '5', onlyExactGraphs: 'true' }));
  assert.deepEqual(options, { sort: GRAPH_SORT.MOST_DOWNLOADED, limit: 5, filters: { onlyExactGraphs: true } });
});

test('parseSearchQuery maps hash/angle/length params directly', () => {
  const query = parseSearchQuery(sp({ hash: 'abc', angleA: '15', angleB: '50', baseLength: '90' }));
  assert.deepEqual(query, { hash: 'abc', angleA: 15, angleB: 50, baseLength: 90 });
});

test('parseSearchQuery maps the public "code" query param to sequenceText internally', () => {
  const query = parseSearchQuery(sp({ code: '3 1 7 2 6 2 8 2 4 2' }));
  assert.deepEqual(query, { sequenceText: '3 1 7 2 6 2 8 2 4 2' });
});

test('parseSearchQuery returns an empty object when nothing searchable was provided', () => {
  assert.deepEqual(parseSearchQuery(sp('')), {});
});
