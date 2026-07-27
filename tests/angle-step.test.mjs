import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAngleStep, displayScaleForStep, computeSweepRange } from '../src/anglePlot/angleStep.js';

test('parseAngleStep accepts whole numbers with scale 0', () => {
  const result = parseAngleStep('1');
  assert.equal(result.valid, true);
  assert.equal(result.scale, 0);
  assert.equal(result.stepUnits, 1n);
  assert.equal(result.stepDegrees, 1);
});

test('parseAngleStep accepts one decimal place', () => {
  const result = parseAngleStep('0.1');
  assert.equal(result.valid, true);
  assert.equal(result.scale, 1);
  assert.equal(result.stepUnits, 1n);
});

test('parseAngleStep accepts two decimal places', () => {
  const result = parseAngleStep('0.01');
  assert.equal(result.valid, true);
  assert.equal(result.scale, 2);
  assert.equal(result.stepUnits, 1n);
});

test('parseAngleStep accepts a seven-decimal-place step exactly (the 0.0000003 example)', () => {
  const result = parseAngleStep('0.0000003');
  assert.equal(result.valid, true);
  assert.equal(result.scale, 7);
  assert.equal(result.stepUnits, 3n);
  assert.equal(result.stepDegrees, 0.0000003);
});

test('parseAngleStep rejects zero', () => {
  const result = parseAngleStep('0');
  assert.equal(result.valid, false);
  assert.match(result.error, /greater than zero/);
});

test('parseAngleStep rejects a negative value', () => {
  const result = parseAngleStep('-1');
  assert.equal(result.valid, false);
  assert.match(result.error, /greater than zero/);
});

test('parseAngleStep rejects a blank string', () => {
  assert.equal(parseAngleStep('').valid, false);
  assert.equal(parseAngleStep('   ').valid, false);
});

test('parseAngleStep rejects non-numeric input', () => {
  const result = parseAngleStep('abc');
  assert.equal(result.valid, false);
  assert.match(result.error, /numeric/);
});

test('parseAngleStep rejects scientific notation (exact-digit parsing requires plain decimal)', () => {
  const result = parseAngleStep('3e-7');
  assert.equal(result.valid, false);
  assert.match(result.error, /scientific notation/);
});

test('displayScaleForStep mirrors the step scale, floored at zero', () => {
  assert.equal(displayScaleForStep(0), 0);
  assert.equal(displayScaleForStep(1), 1);
  assert.equal(displayScaleForStep(7), 7);
});

test('computeSweepRange narrows the A range to the viewport and leaves it untouched outside the view', () => {
  const { scale, stepUnits } = parseAngleStep('1');
  const unbounded = computeSweepRange(scale, stepUnits, undefined);
  const bounded = computeSweepRange(scale, stepUnits, { minA: 10, maxA: 20, minB: 40, maxB: 50 });

  assert.ok(bounded.startAUnits > unbounded.startAUnits, 'expected the view to raise the A start above the domain minimum');
  assert.ok(bounded.endAUnits < unbounded.endAUnits, 'expected the view to lower the A end below the domain maximum');
  assert.equal(bounded.startAUnits, 10n);
  assert.equal(bounded.endAUnits, 20n);
  assert.equal(bounded.minBUnits, 40n);
  assert.equal(bounded.maxBUnitsCap, 50n);
});

test('computeSweepRange with no viewBounds imposes no extra B bound', () => {
  const { scale, stepUnits } = parseAngleStep('1');
  const range = computeSweepRange(scale, stepUnits, undefined);
  assert.equal(range.minBUnits, null);
  assert.equal(range.maxBUnitsCap, null);
});
