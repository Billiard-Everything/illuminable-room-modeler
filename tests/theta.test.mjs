import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTheta, formatTheta, THETA_INITIAL_CONSTANT } from '../src/anglePlot/theta.js';

// The exact worked example this feature was specified against.
const DEFAULT_PARSED_SEQUENCE = [
  { count: 3, angle: 'y' },
  { count: 1, angle: 'z' },
  { count: 7, angle: 'x' },
  { count: 2, angle: 'y' },
  { count: 6, angle: 'x' },
  { count: 2, angle: 'y' },
  { count: 8, angle: 'x' },
  { count: 2, angle: 'y' },
  { count: 4, angle: 'x' },
  { count: 2, angle: 'y' },
];

test('calculateTheta on the worked example (code 3 1 7 2 6 2 8 2 4 2) produces {constant: 270, x: -26, y: 4}', () => {
  assert.deepEqual(calculateTheta(DEFAULT_PARSED_SEQUENCE), { constant: 270, x: -26, y: 4 });
});

test('formatTheta on the worked example produces exactly "θ = 270 - 26X + 4Y"', () => {
  const theta = calculateTheta(DEFAULT_PARSED_SEQUENCE);
  assert.equal(formatTheta(theta), 'θ = 270 - 26X + 4Y');
});

test('THETA_INITIAL_CONSTANT is 90, and a single x term reduces to just that plus the alternated term', () => {
  assert.equal(THETA_INITIAL_CONSTANT, 90);
  // Single term, index 0 -> sign is negative.
  assert.deepEqual(calculateTheta([{ count: 5, angle: 'x' }]), { constant: 90, x: -5, y: 0 });
});

test('signs alternate strictly by position (- + - + - + ...), never by which symbol the term is', () => {
  const sequence = [
    { count: 1, angle: 'x' }, // index 0 -> -
    { count: 1, angle: 'x' }, // index 1 -> +
    { count: 1, angle: 'x' }, // index 2 -> -
    { count: 1, angle: 'x' }, // index 3 -> +
  ];
  // -1 + 1 - 1 + 1 = 0
  assert.deepEqual(calculateTheta(sequence), { constant: 90, x: 0, y: 0 });
});

test('a z term substitutes Z = 180 - X - Y with its own signed coefficient', () => {
  // Single z term at index 0 -> sign -1, coefficient -1.
  // constant += -1*180 = -180; x -= -1 => +1; y -= -1 => +1.
  assert.deepEqual(calculateTheta([{ count: 1, angle: 'z' }]), { constant: 90 - 180, x: 1, y: 1 });
});

test('a z term with a coefficient greater than 1 scales all three substituted parts', () => {
  // Index 0 -> sign -1, coefficient -1*4 = -4.
  // constant += -4*180 = -720; x -= -4 => +4; y -= -4 => +4.
  assert.deepEqual(calculateTheta([{ count: 4, angle: 'z' }]), { constant: 90 - 720, x: 4, y: 4 });
});

test('multiple x terms combine into one coefficient', () => {
  const sequence = [
    { count: 3, angle: 'x' }, // index 0 -> -3
    { count: 2, angle: 'y' }, // index 1 -> +2 (unrelated, isolates the x sum)
    { count: 5, angle: 'x' }, // index 2 -> -5
  ];
  assert.deepEqual(calculateTheta(sequence), { constant: 90, x: -8, y: 2 });
});

test('multiple y terms combine into one coefficient', () => {
  const sequence = [
    { count: 3, angle: 'y' }, // index 0 -> -3
    { count: 2, angle: 'x' }, // index 1 -> +2 (unrelated, isolates the y sum)
    { count: 5, angle: 'y' }, // index 2 -> -5
  ];
  assert.deepEqual(calculateTheta(sequence), { constant: 90, x: 2, y: -8 });
});

test('formatTheta never displays an explicit coefficient of 1', () => {
  assert.equal(formatTheta({ constant: 90, x: -1, y: 1 }), 'θ = 90 - X + Y');
});

test('formatTheta drops zero terms entirely, including a zero constant', () => {
  assert.equal(formatTheta({ constant: 180, x: 0, y: -4 }), 'θ = 180 - 4Y');
  assert.equal(formatTheta({ constant: 0, x: 5, y: -3 }), 'θ = 5X - 3Y');
});

test('formatTheta never produces a "+ -" run for a negative non-leading term', () => {
  const formatted = formatTheta({ constant: 270, x: -26, y: 4 });
  assert.ok(!formatted.includes('+ -'), `expected no "+ -" run, got: ${formatted}`);
});

test('formatTheta handles a negative constant as the leading term', () => {
  assert.equal(formatTheta({ constant: -5, x: 2, y: 0 }), 'θ = -5 + 2X');
});

test('formatTheta handles X being the first (and only) visible term when the constant is zero', () => {
  assert.equal(formatTheta({ constant: 0, x: -1, y: 0 }), 'θ = -X');
  assert.equal(formatTheta({ constant: 0, x: 1, y: 0 }), 'θ = X');
});

test('formatTheta falls back to "θ = 0" when every coefficient is zero', () => {
  assert.equal(formatTheta({ constant: 0, x: 0, y: 0 }), 'θ = 0');
});

test('calculateTheta returns null for an empty sequence, and formatTheta shows "θ = —" for it', () => {
  assert.equal(calculateTheta([]), null);
  assert.equal(formatTheta(calculateTheta([])), 'θ = —');
});

test('calculateTheta returns null for missing/invalid input rather than throwing', () => {
  assert.equal(calculateTheta(undefined), null);
  assert.equal(calculateTheta(null), null);
  assert.equal(formatTheta(null), 'θ = —');
});
