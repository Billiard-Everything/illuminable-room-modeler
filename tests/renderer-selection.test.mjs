import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseRenderer, RENDERER_MODE, CANDIDATES_PER_SECOND, DEFAULT_TIME_BUDGET_SECONDS } from '../src/anglePlot/rendererSelection.js';
import { parseAngleStep } from '../src/anglePlot/angleStep.js';

test('chooseRenderer picks brute force for a small/simple graph (coarse step)', () => {
  const { scale, stepUnits } = parseAngleStep('10');
  const decision = chooseRenderer({ scale, stepUnits });
  assert.equal(decision.mode, RENDERER_MODE.BRUTE_FORCE);
  assert.ok(decision.estimatedSeconds <= decision.timeBudgetSeconds);
});

test('chooseRenderer picks adaptive for a large/complex graph (very fine step)', () => {
  const { scale, stepUnits } = parseAngleStep('0.0001');
  const decision = chooseRenderer({ scale, stepUnits });
  assert.equal(decision.mode, RENDERER_MODE.ADAPTIVE);
  assert.ok(decision.estimatedSeconds > decision.timeBudgetSeconds);
});

test('chooseRenderer defaults to a 6-second time budget', () => {
  const { scale, stepUnits } = parseAngleStep('1');
  const decision = chooseRenderer({ scale, stepUnits });
  assert.equal(decision.timeBudgetSeconds, DEFAULT_TIME_BUDGET_SECONDS);
  assert.equal(DEFAULT_TIME_BUDGET_SECONDS, 6);
});

test('chooseRenderer estimatedSeconds is estimatedIterations / CANDIDATES_PER_SECOND', () => {
  const { scale, stepUnits } = parseAngleStep('1');
  const decision = chooseRenderer({ scale, stepUnits });
  const expected = Number(decision.estimatedIterations) / CANDIDATES_PER_SECOND;
  assert.equal(decision.estimatedSeconds, expected);
});

test('chooseRenderer never benchmarks — it is a pure function of scale/stepUnits, called synchronously', () => {
  const { scale, stepUnits } = parseAngleStep('5');
  const before = Date.now();
  const decision = chooseRenderer({ scale, stepUnits });
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 50, `expected an instant estimate, took ${elapsed}ms`);
  assert.ok(typeof decision.estimatedIterations === 'bigint');
});

test('chooseRenderer respects a custom timeBudgetSeconds override', () => {
  const { scale, stepUnits } = parseAngleStep('1');
  const relaxed = chooseRenderer({ scale, stepUnits, timeBudgetSeconds: 0 });
  const strict = chooseRenderer({ scale, stepUnits, timeBudgetSeconds: 1000 });
  assert.equal(relaxed.mode, RENDERER_MODE.ADAPTIVE, 'a zero-second budget should never choose brute force');
  assert.equal(strict.mode, RENDERER_MODE.BRUTE_FORCE, 'an enormous budget should always choose brute force');
});

test('a finer step consistently estimates a longer (or equal) brute-force cost than a coarser one', () => {
  const coarse = chooseRenderer(parseAngleStep('1'));
  const fine = chooseRenderer(parseAngleStep('0.1'));
  assert.ok(fine.estimatedSeconds >= coarse.estimatedSeconds);
  assert.ok(fine.estimatedIterations >= coarse.estimatedIterations);
});
