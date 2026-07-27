import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAngleRegion } from '../src/anglePlot/generateAngleRegion.js';
import { parseAngleStep } from '../src/anglePlot/angleStep.js';
import { OBTUSE_THIRD_ANGLE_LIMIT_DEGREES, ANGLE_EPSILON_DEGREES } from '../src/anglePlot/angleValidation.js';

const acceptAll = () => ({ allowed: true });

// A whole-degree step keeps these correctness tests fast (~10^3 candidates)
// without weakening what they check; the dedicated "0.1" test below is the
// one that exercises a denser, closer-to-real-usage sweep.
const wholeDegreeStep = parseAngleStep('1');

test('generateAngleRegion only returns points satisfying A < B and A + B <= 90', async () => {
  const { promise } = generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...wholeDegreeStep });
  const points = await promise;

  assert.ok(points.length > 0, 'expected at least some valid points with an always-accepting validator');
  for (const { a, b } of points) {
    assert.ok(a < b, `expected A < B, got A=${a} B=${b}`);
    assert.ok(a + b <= OBTUSE_THIRD_ANGLE_LIMIT_DEGREES + ANGLE_EPSILON_DEGREES, `expected A+B <= 90, got A=${a} B=${b} sum=${a + b}`);
    assert.ok(a > 0 && b > 0, `expected strictly positive angles, got A=${a} B=${b}`);
  }
});

test('generateAngleRegion never produces duplicate (A, B) points', async () => {
  const { promise } = generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...wholeDegreeStep });
  const points = await promise;
  const seen = new Set(points.map((p) => `${p.a}_${p.b}`));
  assert.equal(seen.size, points.length);
});

test('generateAngleRegion respects rejections from the injected app validator', async () => {
  // Simulate the main program only accepting a small window around a
  // "currently selected" pair, the way the real Constrained-mode tower
  // validation only accepts nearby perturbations of the committed shot.
  const windowValidator = ({ a, b }) => ({ allowed: a >= 10 && a <= 20 && b >= 40 && b <= 50 });
  const { promise } = generateAngleRegion({ validateCandidate: windowValidator, baseLength: 10, ...wholeDegreeStep });
  const points = await promise;

  assert.ok(points.length > 0, 'expected some points inside the allowed window');
  for (const { a, b } of points) {
    assert.ok(a >= 10 && a <= 20, `A=${a} escaped the injected validator's window`);
    assert.ok(b >= 40 && b <= 50, `B=${b} escaped the injected validator's window`);
  }
});

test('generateAngleRegion reports progress and a final done event', async () => {
  const events = [];
  const { promise } = generateAngleRegion({
    validateCandidate: acceptAll,
    baseLength: 10,
    ...wholeDegreeStep,
    onProgress: (p) => events.push(p),
  });
  const points = await promise;

  assert.ok(events.length > 0, 'expected at least one progress event');
  const last = events[events.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.cancelled, false);
  assert.equal(last.found, points.length);
  // `total` is a closed-form estimate (documented in generateAngleRegion.js),
  // not an exact count, so it only needs to be in the same ballpark as the
  // actual number tested — not an exact match.
  assert.ok(last.tested > 0);
  assert.ok(last.total > 0);
  assert.ok(last.tested / last.total > 0.3 && last.tested / last.total < 3, `expected tested (${last.tested}) and total estimate (${last.total}) to be roughly comparable`);
});

test('generateAngleRegion stops promptly when cancelled and reports cancelled:true', async () => {
  const events = [];
  const { promise, cancel } = generateAngleRegion({
    validateCandidate: acceptAll,
    baseLength: 10,
    ...wholeDegreeStep,
    onProgress: (p) => events.push(p),
  });
  // The sweep runs synchronously up to its first internal yield point
  // before this line executes, so cancelling here reliably stops it after
  // only the first chunk rather than the full sweep.
  cancel();
  await promise;

  const last = events[events.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.cancelled, true);
});

test('generateAngleRegion stops at maxRenderMs and reports timeLimited:true, keeping whatever it found', async () => {
  // A fine enough step to guarantee many chunks/yields even in the tiny
  // maxRenderMs window below, so the backstop actually has a chance to
  // fire mid-sweep rather than finishing first by coincidence.
  const step = parseAngleStep('0.01');
  const events = [];
  const { promise } = generateAngleRegion({
    validateCandidate: acceptAll,
    baseLength: 10,
    ...step,
    maxRenderMs: 5,
    onProgress: (p) => events.push(p),
  });
  const points = await promise;

  const last = events[events.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.cancelled, false);
  assert.equal(last.timeLimited, true);
  assert.equal(points.length, last.found);
  assert.ok(last.tested < last.total, 'expected the backstop to stop well before the full estimated sweep');
});

test('generateAngleRegion does not report timeLimited when it finishes within maxRenderMs', async () => {
  const events = [];
  const { promise } = generateAngleRegion({
    validateCandidate: acceptAll,
    baseLength: 10,
    ...wholeDegreeStep,
    maxRenderMs: 60_000,
    onProgress: (p) => events.push(p),
  });
  await promise;

  const last = events[events.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.timeLimited, false);
});

test('generateAngleRegion works at the previous fixed 0.1-degree resolution too', async () => {
  const step = parseAngleStep('0.1');
  const { promise } = generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...step });
  const points = await promise;

  assert.ok(points.length > 0);
  for (const { a, b } of points) {
    assert.ok(a < b);
    assert.ok(a + b <= OBTUSE_THIRD_ANGLE_LIMIT_DEGREES + ANGLE_EPSILON_DEGREES);
  }
});

test('a coarser step produces a coarser (smaller) point set than a finer step over the same region', async () => {
  const coarse = await generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...parseAngleStep('1') }).promise;
  const fine = await generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...parseAngleStep('0.1') }).promise;
  assert.ok(fine.length > coarse.length, `expected the 0.1 step (${fine.length} points) to produce more points than the 1 step (${coarse.length} points)`);
});

test('generateAngleRegion with viewBounds only returns points inside that rectangle', async () => {
  const step = parseAngleStep('0.5');
  const { promise } = generateAngleRegion({
    validateCandidate: acceptAll,
    baseLength: 10,
    ...step,
    viewBounds: { minA: 10, maxA: 20, minB: 40, maxB: 50 },
  });
  const points = await promise;

  assert.ok(points.length > 0, 'expected some points inside the bounded view');
  for (const { a, b } of points) {
    assert.ok(a >= 10 && a <= 20, `A=${a} escaped the view bounds`);
    assert.ok(b >= 40 && b <= 50, `B=${b} escaped the view bounds`);
  }
});

test('generateAngleRegion with viewBounds is a subset of the unbounded sweep over the same step', async () => {
  const step = parseAngleStep('0.5');
  const viewBounds = { minA: 10, maxA: 20, minB: 40, maxB: 50 };
  const bounded = await generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...step, viewBounds }).promise;
  const full = await generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...step }).promise;
  const fullKeys = new Set(full.map((p) => `${p.a}_${p.b}`));

  assert.ok(bounded.length > 0 && bounded.length < full.length);
  for (const p of bounded) {
    assert.ok(fullKeys.has(`${p.a}_${p.b}`), `bounded point A=${p.a} B=${p.b} was not found in the unbounded sweep`);
  }
});

test('generateAngleRegion respects a non-tenths decimal step (0.25) precisely', async () => {
  // 0.25 only divides the 0-90 range into 360 steps (fast to sweep in full)
  // while still exercising a 2-decimal-place scale, unlike the round 1/0.1
  // steps used above. A step like 0.01 divides the range into 9000 steps
  // (~10^7 candidate pairs) and is deliberately not swept in full here —
  // that resolution is covered by the parseAngleStep/estimate unit tests in
  // angle-step.test.mjs instead, to keep this suite fast.
  const step = parseAngleStep('0.25');
  const { promise } = generateAngleRegion({ validateCandidate: acceptAll, baseLength: 10, ...step });
  const points = await promise;

  assert.ok(points.length > 0);
  for (const { a, b } of points) {
    // Every generated value must land exactly on the 0.25 grid.
    assert.equal(Math.round(a * 4), a * 4, `A=${a} is not on the 0.25 grid`);
    assert.equal(Math.round(b * 4), b * 4, `B=${b} is not on the 0.25 grid`);
  }
});
