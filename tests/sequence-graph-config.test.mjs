import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEQUENCE_COLOR_PALETTE,
  colorForSequenceNumber,
  createSequenceRow,
  truncateSequenceText,
} from '../src/sequences/sequenceGraphConfig.js';

test('colorForSequenceNumber assigns palette colors in a fixed, cycling order', () => {
  assert.equal(colorForSequenceNumber(1), SEQUENCE_COLOR_PALETTE[0].hex);
  assert.equal(colorForSequenceNumber(2), SEQUENCE_COLOR_PALETTE[1].hex);
  assert.equal(colorForSequenceNumber(SEQUENCE_COLOR_PALETTE.length), SEQUENCE_COLOR_PALETTE.at(-1).hex);
  // Cycles back to the first color once the palette is exhausted, rather than erroring or repeating undefined.
  assert.equal(colorForSequenceNumber(SEQUENCE_COLOR_PALETTE.length + 1), SEQUENCE_COLOR_PALETTE[0].hex);
});

test('createSequenceRow builds a stable id/label pair from the creation number', () => {
  const row = createSequenceRow({ number: 3, sequenceText: '1 2 3', angleStepInput: '0.05' });
  assert.equal(row.id, 'seq-3');
  assert.equal(row.label, 'Graph 3');
  assert.equal(row.sequenceText, '1 2 3');
  assert.equal(row.angleStepInput, '0.05');
  assert.equal(row.color, colorForSequenceNumber(3));
  assert.equal(row.visible, true);
});

test('createSequenceRow defaults to an empty sequence and a usable Angle Step', () => {
  const row = createSequenceRow({ number: 1 });
  assert.equal(row.sequenceText, '');
  assert.equal(row.angleStepInput, '0.1');
});

test('two rows created with different numbers never collide on id or default color pairing', () => {
  const first = createSequenceRow({ number: 1 });
  const second = createSequenceRow({ number: 2 });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.color, second.color);
});

test('truncateSequenceText leaves short text untouched and marks empty text explicitly', () => {
  assert.equal(truncateSequenceText('1 2 3'), '1 2 3');
  assert.equal(truncateSequenceText(''), '(empty)');
  assert.equal(truncateSequenceText('   '), '(empty)');
});

test('truncateSequenceText shortens long text and keeps it under the requested length', () => {
  const long = '3 1 7 2 6 2 8 2 4 2 5 5 5 5 5 5 5 5 5';
  const truncated = truncateSequenceText(long, 10);
  assert.ok(truncated.length <= 10);
  assert.ok(truncated.endsWith('…'));
  assert.ok(long.startsWith(truncated.slice(0, -1)));
});
