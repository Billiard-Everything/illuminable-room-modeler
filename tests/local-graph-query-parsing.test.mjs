import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalListOptions, parseLocalSearchQuery, LOCAL_GRAPH_SORT } from '../server/api/localGraphQueryParsing.js';

const params = (obj) => new URLSearchParams(obj);

test('parseLocalListOptions defaults to newest (createdAt desc) when sort is absent', () => {
  assert.deepEqual(parseLocalListOptions(params({})), { sortBy: 'createdAt', order: 'desc' });
});

test('parseLocalListOptions maps every LOCAL_GRAPH_SORT value to its sortBy/order pair', () => {
  assert.deepEqual(parseLocalListOptions(params({ sort: LOCAL_GRAPH_SORT.NEWEST })), { sortBy: 'createdAt', order: 'desc' });
  assert.deepEqual(parseLocalListOptions(params({ sort: LOCAL_GRAPH_SORT.OLDEST })), { sortBy: 'createdAt', order: 'asc' });
  assert.deepEqual(parseLocalListOptions(params({ sort: LOCAL_GRAPH_SORT.RECENTLY_MODIFIED })), { sortBy: 'modifiedAt', order: 'desc' });
  assert.deepEqual(parseLocalListOptions(params({ sort: LOCAL_GRAPH_SORT.TITLE_ASC })), { sortBy: 'title', order: 'asc' });
});

test('parseLocalListOptions falls back to the default for an unrecognized sort value, never throwing', () => {
  assert.deepEqual(parseLocalListOptions(params({ sort: 'not-a-real-sort' })), { sortBy: 'createdAt', order: 'desc' });
});

test('parseLocalListOptions includes limit/offset only when present, as numbers', () => {
  assert.deepEqual(parseLocalListOptions(params({ limit: '10', offset: '20' })), { sortBy: 'createdAt', order: 'desc', limit: 10, offset: 20 });
  assert.ok(!('limit' in parseLocalListOptions(params({}))));
});

test('parseLocalSearchQuery maps code -> codeSequence and parses numeric fields', () => {
  assert.deepEqual(
    parseLocalSearchQuery(params({ code: 'RRL', angleA: '15', angleB: '50', baseLength: '90' })),
    { codeSequence: 'RRL', angleA: 15, angleB: 50, baseLength: 90 },
  );
});

test('parseLocalSearchQuery includes title/favorite/visibility only when present', () => {
  assert.deepEqual(parseLocalSearchQuery(params({ title: 'My Graph' })), { title: 'My Graph' });
  assert.deepEqual(parseLocalSearchQuery(params({ favorite: 'true' })), { favorite: true });
  assert.deepEqual(parseLocalSearchQuery(params({ favorite: 'false' })), {});
  assert.deepEqual(parseLocalSearchQuery(params({ visibility: 'public' })), { visibility: 'public' });
});

test('parseLocalSearchQuery parses a comma-separated tags query param into an array', () => {
  assert.deepEqual(parseLocalSearchQuery(params({ tags: 'a, b ,c' })), { tags: ['a', 'b', 'c'] });
});

test('parseLocalSearchQuery returns {} when nothing is present', () => {
  assert.deepEqual(parseLocalSearchQuery(params({})), {});
});
