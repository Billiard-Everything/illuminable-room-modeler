// AngleRegionGenerator equivalent: enumerates every (A, B) grid point that
// passes isValidAnglePair, without freezing the caller's JS thread.
//
// Full-range sweep vs. BFS from the current pair
// ------------------------------------------------
// The task description offers two strategies: enumerate the whole permitted
// range, or breadth-first search outward from the currently selected A/B.
// This project's existing candidate check (`validateLockedAngleCandidate` in
// App.jsx, threaded through here as `validateCandidate`) evaluates each
// candidate independently against a *fixed* reference (the currently
// committed code path) — it does not depend on the previous point visited,
// so there is no adjacency/history requirement that would force a BFS walk.
// A full sweep is therefore both correct (BFS could miss a disconnected
// valid pocket the current point isn't connected to) and simple, so that is
// what this module does — as long as the step keeps the sweep small enough,
// which is exactly what the pre-flight estimate in angleStep.js is for.
//
// Not freezing the GUI
// ---------------------
// JavaScript in a browser tab is single-threaded — there is no direct
// equivalent of spinning up a Java worker thread without moving this whole
// validation pipeline (which reaches back into React state via the
// `validateCandidate` closure) into a Web Worker, which would require
// serializing that closure and is a much larger change than this feature
// needs. Instead, this generator time-slices the sweep: it runs a bounded
// chunk of candidate checks, then yields to the event loop with
// `setTimeout(0)` so the browser can paint and handle input before the next
// chunk runs. Because everything still executes on the one JS thread, GUI
// state is only ever touched from that same thread (via the `onProgress`
// callback, which the caller uses to drive React state) — there is no
// separate thread that could touch it from elsewhere.
//
// Arbitrary decimal steps
// ------------------------
// A and B are walked as BigInt multiples of `stepUnits` (the step expressed
// as an exact integer at the caller-supplied `scale`, from angleStep.js).
// BigInt addition never drifts, no matter how small the step or how many
// iterations run, and no "seen" set is needed for de-duplication: each
// (aUnits, bUnits) integer pair is visited by the nested loop exactly once.
// Angles are converted to floating-point degrees only once per point, right
// before handing them to isValidAnglePair/validateCandidate.

import { isValidAnglePair, ANGLE_EPSILON_DEGREES } from './angleValidation.js';
import { computeSweepRange, estimateAngleGridIterations } from './angleStep.js';
import { MAX_ADAPTIVE_RENDER_MS } from './renderSamplingPolicy.js';

// Starting chunk size (candidates tested before the first yield), and the
// range subsequent chunks are allowed to adapt into — see the "adaptive
// chunk sizing" comment below for why a fixed count doesn't work well
// across the huge range of per-candidate costs this sweep can see.
const INITIAL_CANDIDATES_PER_CHUNK = 1500;
const MIN_CANDIDATES_PER_CHUNK = 100;
const MAX_CANDIDATES_PER_CHUNK = 20000;
// Target wall-clock time per chunk. Chunk size adapts toward whatever
// candidate count fills roughly this much time. Measured (Node, real
// validateCandidate, step=0.1, 202k candidates): 12ms produced 935 yields
// and an 18s sweep; every `await setTimeout(resolve, 0)` costs several ms
// of real scheduling overhead regardless of the requested 0ms delay, so a
// budget this small mostly measures yield overhead, not the target frame
// rate. 40ms still finishes well within "feels responsive" (comfortably
// under the ~100ms RAIL response-time threshold) while cutting yields to
// 277 and the same sweep to ~13s — same candidates tested, same points
// found, purely fewer yields.
const FRAME_BUDGET_MS = 40;

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Starts a cancellable, chunked sweep of the valid A/B grid at an arbitrary
 * decimal step.
 *
 * @param {object} options
 * @param {(candidate: {a:number,b:number,length:number}) => {allowed:boolean, reason?:string}} options.validateCandidate
 *   The app's existing constraint check, reused as-is (see module comment).
 * @param {number} options.baseLength - current base-triangle length, passed through to validateCandidate.
 * @param {number} options.scale - decimal places in the step (from parseAngleStep).
 * @param {bigint} options.stepUnits - the step, as an exact integer at `scale` (from parseAngleStep).
 * @param {{minA:number,maxA:number,minB:number,maxB:number}} [options.viewBounds] -
 *   Optional viewport rectangle (plain degrees, e.g. from the plot panel's
 *   current pan/zoom). When given, the sweep only walks grid points inside
 *   this rectangle (still intersected with the fixed A<B, A+B<=90 domain),
 *   so a very fine step stays tractable by covering a zoomed-in area
 *   instead of always the whole 0-90 triangle. Omit for the full domain.
 * @param {(progress: {tested:number, total:number, found:number, done:boolean, cancelled:boolean, timeLimited?:boolean}) => void} [options.onProgress]
 * @param {number} [options.maxRenderMs] - wall-clock backstop; defaults to
 *   MAX_ADAPTIVE_RENDER_MS. Overridable mainly so tests can exercise the
 *   backstop itself without waiting out the real multi-second default.
 * @returns {{ promise: Promise<{a:number,b:number}[]>, cancel: () => void }}
 */
export const generateAngleRegion = ({ validateCandidate, baseLength, scale, stepUnits, viewBounds, onProgress, maxRenderMs = MAX_ADAPTIVE_RENDER_MS }) => {
  let cancelled = false;

  const unitToDegrees = 10 ** scale;
  const stepDegrees = Number(stepUnits) / unitToDegrees;
  // isValidAnglePair's default tolerance exists to absorb ordinary
  // floating-point noise, not to accommodate the grid step itself. A step
  // smaller than that default (e.g. 0.0000003) would make two genuinely
  // adjacent, intentionally-distinct grid points look "equal" under it, so
  // this caps the tolerance well under the step (1/1000th of it) — still
  // far larger than the noise from the single BigInt-to-Number division
  // below, but never large enough to swallow a real step.
  const epsilon = Math.min(ANGLE_EPSILON_DEGREES, stepDegrees / 1000);
  // Shared with the pre-flight estimate (angleStep.js) so the range actually
  // walked here and the number shown/checked before the sweep starts never
  // disagree. See computeSweepRange's doc comment for what minBUnits/
  // maxBUnitsCap mean when viewBounds is omitted (null = no extra bound).
  const { limitUnits, startAUnits, endAUnits, minBUnits, maxBUnitsCap } = computeSweepRange(scale, stepUnits, viewBounds);
  // A rough (not exact) total for the progress bar — good enough for a
  // percentage display without an O(n) precomputation loop before the sweep
  // even starts.
  const totalEstimate = Number(estimateAngleGridIterations(scale, stepUnits, viewBounds));

  const promise = (async () => {
    const startedAt = performance.now();
    let timeLimited = false;
    const points = [];
    let tested = 0;
    // Adaptive chunk sizing: start at INITIAL_CANDIDATES_PER_CHUNK, then
    // after every chunk, rescale the target toward whatever candidate count
    // would have taken FRAME_BUDGET_MS, based on how long the chunk that
    // just ran actually took. When validateCandidate is expensive (it runs
    // a full code unfolding/path validation — see App.jsx's
    // validateLockedAngleCandidate) this converges to a small chunk size so
    // the UI stays responsive; when candidates are cheap it converges to a
    // large one, so a huge sweep doesn't spend a large fraction of its total
    // time on setTimeout(0) yield overhead (browsers clamp nested timeouts
    // to a minimum delay) the way a small fixed chunk size would. Checking
    // the clock only once per chunk (not per candidate) keeps that overhead
    // itself negligible even across a multi-billion-candidate sweep.
    let chunkTarget = INITIAL_CANDIDATES_PER_CHUNK;
    let sinceYield = 0;
    let chunkStart = performance.now();

    outer: for (let aUnits = startAUnits; aUnits <= endAUnits; aUnits += stepUnits) {
      const angleA = Number(aUnits) / unitToDegrees;
      const domainBMaxUnits = limitUnits - aUnits;
      const bMaxUnits = maxBUnitsCap !== null && maxBUnitsCap < domainBMaxUnits ? maxBUnitsCap : domainBMaxUnits;
      const bMinCandidateUnits = aUnits + stepUnits;
      const bStartUnits = minBUnits !== null && minBUnits > bMinCandidateUnits ? minBUnits : bMinCandidateUnits;
      for (let bUnits = bStartUnits; bUnits <= bMaxUnits; bUnits += stepUnits) {
        const angleB = Number(bUnits) / unitToDegrees;
        tested++;
        sinceYield++;

        if (isValidAnglePair(angleA, angleB, { validateCandidate, baseLength, epsilon })) {
          points.push({ a: angleA, b: angleB });
        }

        if (sinceYield >= chunkTarget) {
          const elapsedMs = performance.now() - chunkStart;
          onProgress?.({ tested, total: totalEstimate, found: points.length, done: false, cancelled: false });
          await yieldToEventLoop();
          if (cancelled) break outer;
          // Hard wall-clock backstop, mirroring visibleAnglePointGenerator.js's
          // MAX_ADAPTIVE_RENDER_MS: rendererSelection.js only ever routes a
          // configuration here when its *estimated* cost is within budget, but
          // an estimate is still an estimate — an unusually expensive
          // validateCandidate (e.g. a very long code sequence) could make the
          // real cost exceed it. This is the safety net for that case: stop
          // and return whatever was found so far rather than keep the UI
          // waiting far past what the estimate promised.
          if (performance.now() - startedAt > maxRenderMs) {
            timeLimited = true;
            break outer;
          }
          if (elapsedMs > 0) {
            const rescaled = Math.round(chunkTarget * (FRAME_BUDGET_MS / elapsedMs));
            chunkTarget = Math.min(MAX_CANDIDATES_PER_CHUNK, Math.max(MIN_CANDIDATES_PER_CHUNK, rescaled));
          }
          sinceYield = 0;
          chunkStart = performance.now();
        }
      }
    }

    onProgress?.({ tested, total: totalEstimate, found: points.length, done: true, cancelled, timeLimited });
    return points;
  })();

  return {
    promise,
    cancel: () => { cancelled = true; },
  };
};
