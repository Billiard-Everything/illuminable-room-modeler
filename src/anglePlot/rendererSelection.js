// RendererSelection: the one place that decides, for a given graph
// configuration, whether the exact full-domain brute-force sweep
// (generateAngleRegion.js) or the adaptive, viewport-scoped sampler
// (visibleAnglePointGenerator.js) should render it. AnglePlotWindow.jsx's
// job-scheduling code asks chooseRenderer() and dispatches to whichever
// generator it names — it never re-implements or duplicates this
// threshold logic itself, which is exactly what keeps this a one-module
// decision instead of one scattered through the caller.
//
// Why estimate instead of benchmark
// ------------------------------------
// Actually running brute force to see how long it takes would defeat the
// entire point: a brute-force sweep that turns out to be slow is exactly
// the failure mode this selection exists to avoid, and running it "just to
// time it" pays that same cost anyway. Instead, the estimate comes from
// the same closed-form iteration count already used for the sweep's own
// progress bar (estimateAngleGridIterations in angleStep.js) — a plain
// count of (A, B) candidate pairs, no actual candidate ever validated —
// converted to a wall-clock estimate via CANDIDATES_PER_SECOND below.
//
// Automatic, not user-chosen
// ----------------------------
// There is no UI for picking a renderer and none should be added here:
// chooseRenderer always returns one answer for a given input, and the
// caller always uses it. The per-row "Generate Anyway" override the old
// single exact-mode threshold used to have is gone on purpose — a
// configuration that estimates as too expensive now falls back to the
// adaptive renderer automatically instead of asking the user to confirm a
// slow sweep.
//
// Cache interaction (see graphCache.js)
// ----------------------------------------
// This module has no opinion on caching — GraphCache already treats a
// cache hit as "skip rendering entirely, regardless of which renderer
// would have been chosen" (see AnglePlotWindow.jsx), so chooseRenderer is
// only ever consulted on a cache miss.
//
// Extension point for background refinement (not implemented here)
// ---------------------------------------------------------------------
// A future stage that progressively refines a coarse cached result in the
// background would plug in right here: chooseRenderer already returns a
// structured decision object rather than a bare string, so a later
// addition (e.g. "start with adaptive immediately, then schedule a
// brute-force refinement pass if the estimate is within some larger
// budget") only needs a new field on that object and a caller that reads
// it — the two renderers themselves, and the decision function's
// signature, do not need to change shape to support it.

import { estimateAngleGridIterations } from './angleStep.js';

export const RENDERER_MODE = { BRUTE_FORCE: 'brute-force', ADAPTIVE: 'adaptive' };

// Conservative candidates/sec throughput for validateCandidate (the
// expensive part of every candidate test — a full code unfolding plus
// blue/black-line validation). Real measurements of this app's own
// validator (see generateAngleRegion.js's FRAME_BUDGET_MS comment) sit
// roughly between 16k-26k/sec for the dense case where most candidates
// reach the full validator. Deliberately using a number at the low end
// (not an average): overestimating brute force's cost only ever means
// choosing the adaptive renderer instead, which is always a safe fallback
// this app already relies on everywhere; underestimating cost is what
// would let a slow sweep back in, exactly the regression this selection
// exists to prevent.
export const CANDIDATES_PER_SECOND = 15_000;

// Default automatic time budget: a configuration only gets the brute-force
// renderer if its estimated wall-clock cost is at or under this. Exported
// (not just inlined into chooseRenderer) so a future settings surface, or
// a different call site, could pass a different budget without touching
// the decision logic itself.
export const DEFAULT_TIME_BUDGET_SECONDS = 6;

/**
 * Chooses a renderer for a given Angle Step from its estimated brute-force
 * cost alone (brute force always sweeps the full 0-90 domain — see
 * generateAngleRegion.js and its integration in AnglePlotWindow.jsx — so
 * the estimate is never narrowed to the current viewport).
 *
 * @param {object} args
 * @param {number} args.scale - decimal places in the Angle Step (parseAngleStep).
 * @param {bigint} args.stepUnits - the Angle Step as an exact integer at `scale`.
 * @param {number} [args.timeBudgetSeconds] - defaults to DEFAULT_TIME_BUDGET_SECONDS.
 * @returns {{ mode: 'brute-force'|'adaptive', estimatedIterations: bigint, estimatedSeconds: number, timeBudgetSeconds: number }}
 */
export const chooseRenderer = ({ scale, stepUnits, timeBudgetSeconds = DEFAULT_TIME_BUDGET_SECONDS }) => {
  const estimatedIterations = estimateAngleGridIterations(scale, stepUnits, undefined);
  const estimatedSeconds = Number(estimatedIterations) / CANDIDATES_PER_SECOND;
  const mode = estimatedSeconds <= timeBudgetSeconds ? RENDERER_MODE.BRUTE_FORCE : RENDERER_MODE.ADAPTIVE;
  return { mode, estimatedIterations, estimatedSeconds, timeBudgetSeconds };
};
