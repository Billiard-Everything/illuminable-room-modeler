// VisibleAnglePointGenerator: the adaptive, zoom-aware counterpart to
// generateAngleRegion.js's exact full/bounded sweep, used only when the
// user's Angle Step is below EXACT_MODE_STEP_THRESHOLD (angleStep.js) — see
// AnglePlotWindow.jsx for the exact/adaptive mode switch.
//
// Where generateAngleRegion.js tests every single point on the user's exact
// Angle Step grid inside a region, this module walks a *coarser* grid (an
// exact whole-number stride over that grid — see renderSamplingPolicy.js's
// calculateSamplingStride) and, for each coarse cell, searches a small,
// deterministic, capped set of the user's real grid points near that cell's
// center for one that is actually valid (see findValidPointInCell). This is
// what keeps "zoom out to look at a 0.0000003-degree Angle Step" from ever
// requiring billions of validateCandidate calls: the number of *cells*
// checked is capped (MAX_VISIBLE_SAMPLE_CELLS), and each cell only tests up
// to MAX_CANDIDATES_PER_CELL real grid points before giving up on that cell.
//
// Determinism: the per-cell search order is a fixed expanding Chebyshev
// ring (center, then ring 1, ring 2, ...), so the same viewport/step/
// constraints always produce the same rendered points.
//
// Validity: every returned point is a real point that passed
// isValidAnglePair (the same check generateAngleRegion.js uses) on the
// user's exact grid. The cell-search never invents or interpolates a point
// — it only decides *where to look* for a real one.

import { isValidAnglePair, ANGLE_EPSILON_DEGREES } from './angleValidation.js';
import { computeSweepRange } from './angleStep.js';
import {
  MAX_CANDIDATES_PER_CELL, MAX_VISIBLE_RENDER_POINTS, VIEW_PRELOAD_MARGIN_STEPS, POINT_DEDUP_PIXEL_SPACING,
  MAX_ADAPTIVE_RENDER_MS, DEBUG_ADAPTIVE_RENDERING, calculateSamplingStride, isWithinRenderCell,
} from './renderSamplingPolicy.js';

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));
// See generateAngleRegion.js's FRAME_BUDGET_MS comment: a 12ms target
// mostly measures `setTimeout(resolve, 0)`'s own several-ms scheduling
// overhead rather than real per-chunk work, so a small budget here means
// more yields than the responsiveness goal actually requires. 40ms is
// still far below MAX_ADAPTIVE_RENDER_MS (6000ms, checked once per chunk
// below), so this can only add at most one chunk's worth of overshoot to
// that cap, and stays comfortably under the ~100ms "feels responsive"
// threshold for a background computation.
const CELL_TIME_BUDGET_MS = 40;
const MIN_CELLS_PER_CHUNK = 50;
// Strides below this test only the exact cell center (see the ringLimit
// comment in generateVisibleAnglePoints for why); at or above it, cells
// search their neighbors too — up to MAX_CANDIDATES_PER_CELL regardless of
// how large ringLimit itself is, so enabling ring search at all is a binary
// ~9x cost jump per cell, not a gradual one. A live test found that jump
// reintroduces the same performance cliff at any threshold low enough to
// matter for a typical zoomed-out view over a thin/sparse valid region, so
// this is set high enough that the vast majority of the practical zoom
// range uses the fast single-candidate test; the OCCUPANCY/DENSE blur (see
// AnglePlotPanel.jsx) already smooths over the resulting minor gaps
// visually, which is an acceptable trade per this feature's explicit
// "even if it isn't totally accurate" requirement. Retune if profiling
// shows a different validator cost than the one this was measured against.
const RING_SEARCH_MIN_STRIDE = 100;
const MAX_CELLS_PER_CHUNK = 4000;

/**
 * Deterministic, capped, Chebyshev-ring search for a valid point near a
 * coarse cell's center, tested only on the user's exact Angle Step grid.
 * Returns { point: {a,b}, tested } with point === null if nothing valid
 * was found within the candidate cap.
 */
export const findValidPointInCell = ({
  centerAUnits, centerBUnits, userStepUnits, unitToDegrees, ringLimit,
  validateCandidate, baseLength, epsilon, domainLimitUnits,
}) => {
  let tested = 0;
  for (let r = 0; r <= ringLimit; r++) {
    for (let ddA = -r; ddA <= r; ddA++) {
      for (let ddB = -r; ddB <= r; ddB++) {
        if (Math.max(Math.abs(ddA), Math.abs(ddB)) !== r) continue; // only the new ring, not cells already tested at a smaller r
        if (tested >= MAX_CANDIDATES_PER_CELL) return { point: null, tested };
        tested++;
        const aUnits = centerAUnits + BigInt(ddA) * userStepUnits;
        const bUnits = centerBUnits + BigInt(ddB) * userStepUnits;
        if (aUnits <= 0n || bUnits <= 0n || aUnits + bUnits > domainLimitUnits) continue;
        const angleA = Number(aUnits) / unitToDegrees;
        const angleB = Number(bUnits) / unitToDegrees;
        if (isValidAnglePair(angleA, angleB, { validateCandidate, baseLength, epsilon })) {
          return { point: { a: angleA, b: angleB }, tested };
        }
      }
    }
  }
  return { point: null, tested };
};

/**
 * Screen-space deduplication using the Chebyshev/square test above: keeps
 * at most one point per (cellSizeA x cellSizeB) world-space cell, checking
 * the 3x3 neighborhood of spatial-hash buckets so points that land just
 * across a bucket boundary are still caught.
 */
export const dedupPointsByCell = (points, cellSizeA, cellSizeB) => {
  if (points.length === 0) return points;
  const halfA = cellSizeA / 2;
  const halfB = cellSizeB / 2;
  const buckets = new Map();
  const kept = [];
  for (const p of points) {
    const bx = Math.floor(p.a / cellSizeA);
    const by = Math.floor(p.b / cellSizeB);
    let collided = false;
    for (let dx = -1; dx <= 1 && !collided; dx++) {
      for (let dy = -1; dy <= 1 && !collided; dy++) {
        const existing = buckets.get(`${bx + dx}:${by + dy}`);
        if (existing && isWithinRenderCell(p.a, p.b, existing.a, existing.b, halfA, halfB)) {
          collided = true;
        }
      }
    }
    if (!collided) {
      buckets.set(`${bx}:${by}`, p);
      kept.push(p);
    }
  }
  return kept;
};

/**
 * Starts a cancellable, chunked, adaptive sweep: only the (margin-padded)
 * visible region is considered, sampled at a zoom-derived stride over the
 * user's exact Angle Step grid (see renderSamplingPolicy.js).
 *
 * @param {object} options
 * @param {(candidate: {a:number,b:number,length:number}) => {allowed:boolean}} options.validateCandidate
 * @param {number} options.baseLength
 * @param {number} options.scale - decimal places in the user's Angle Step (from parseAngleStep).
 * @param {bigint} options.stepUnits - the user's exact Angle Step, as an integer at `scale`.
 * @param {{minA:number,maxA:number,minB:number,maxB:number}} options.viewBounds - current visible world bounds (no margin applied yet).
 * @param {{width:number,height:number}} options.viewportSize
 * @param {number} options.zoomLevel - diagnostic-only (DEBUG_ADAPTIVE_RENDERING logging); does not affect stride selection, since viewBounds/viewportSize already fully determine it (see calculateSamplingStride's own comment).
 * @param {{a:number,b:number}} [options.excludePoint] - typically the current orange A/B pair; suppressed from the blue point list so the two markers never coincide.
 * @param {(progress: {cellsChecked:number, found:number, done:boolean, cancelled:boolean}) => void} [options.onProgress]
 * @returns {{ promise: Promise<{points:{a:number,b:number}[], effectiveStepDegrees:number, stride:number, budgetLimited:boolean, timeLimited:boolean, cellsChecked:number, candidatesTested:number, durationMs:number}>, cancel: () => void }}
 *   `timeLimited` is true when MAX_ADAPTIVE_RENDER_MS was hit before every
 *   cell in the budget could be checked — the cell-count budget
 *   (MAX_VISIBLE_SAMPLE_CELLS) assumes a typical validateCandidate cost;
 *   this is the hard backstop for views where that assumption doesn't hold
 *   (see MAX_ADAPTIVE_RENDER_MS's own comment for a live example).
 */
export const generateVisibleAnglePoints = ({
  validateCandidate, baseLength, scale, stepUnits: userStepUnits, viewBounds, viewportSize, zoomLevel, excludePoint, onProgress,
}) => {
  let cancelled = false;
  const unitToDegrees = 10 ** scale;
  const userStepDegrees = Number(userStepUnits) / unitToDegrees;
  const epsilon = Math.min(ANGLE_EPSILON_DEGREES, userStepDegrees / 1000);

  const { stride, desiredStride, budgetLimited } = calculateSamplingStride({
    userStepDegrees, visibleWorldBounds: viewBounds, viewportSize,
  });
  const effectiveStepUnits = userStepUnits * BigInt(stride);
  const effectiveStepDegrees = Number(effectiveStepUnits) / unitToDegrees;
  const requestedStepDegrees = userStepDegrees * desiredStride;

  const marginDegrees = VIEW_PRELOAD_MARGIN_STEPS * effectiveStepDegrees;
  const paddedBounds = {
    minA: Math.max(0, viewBounds.minA - marginDegrees),
    maxA: Math.min(90, viewBounds.maxA + marginDegrees),
    minB: Math.max(0, viewBounds.minB - marginDegrees),
    maxB: Math.min(90, viewBounds.maxB + marginDegrees),
  };

  const { limitUnits, startAUnits, endAUnits, minBUnits, maxBUnitsCap } = computeSweepRange(scale, effectiveStepUnits, paddedBounds);

  // How far (in the user's exact grid units) the per-cell search is allowed
  // to range from a coarse cell's center. Ring search (testing neighbors,
  // not just the exact center) exists to catch a valid point that's inside
  // a cell but not at its exact center — but it costs up to
  // MAX_CANDIDATES_PER_CELL validateCandidate calls per cell instead of 1,
  // and a live test found that cost cliff dominates real-world performance
  // for this app: at stride 1 ("the cell" is already one exact grid point,
  // so ring search there was pure redundant re-testing of neighbors other
  // iterations already cover) it cut throughput from ~16k-26k checks/sec to
  // ~1.7k/sec; at stride 2-3, ring search made a view that renders fine at
  // stride 1 turn into one that hits MAX_ADAPTIVE_RENDER_MS with zero
  // points found, because most cells outside the (typically thin) valid
  // region exhaust the full ring before giving up.
  //
  // RING_SEARCH_MIN_STRIDE draws the line: below it, test only the exact
  // cell center (matches generateAngleRegion.js's exact sweep — no
  // redundancy, no cliff); at or above it, cells are coarse enough that
  // ring search's boundary-catching value is worth its cost, and a coarse
  // cell missing a thin feature is a smaller fraction of what's on screen
  // anyway. This trades a small amount of boundary accuracy at small-to-
  // medium strides for a large, measured performance win.
  const ringLimit = stride >= RING_SEARCH_MIN_STRIDE ? Math.max(1, Math.min(6, Math.round(stride / 2))) : 0;

  const dedupCellA = POINT_DEDUP_PIXEL_SPACING / Math.max(viewportSize.width, 1) * (viewBounds.maxA - viewBounds.minA || 1);
  const dedupCellB = POINT_DEDUP_PIXEL_SPACING / Math.max(viewportSize.height, 1) * (viewBounds.maxB - viewBounds.minB || 1);

  const promise = (async () => {
    const startedAt = performance.now();
    const points = [];
    let cellsChecked = 0;
    let candidatesTested = 0;
    let chunkTarget = MIN_CELLS_PER_CHUNK;
    let sinceYield = 0;
    let chunkStart = performance.now();
    let timeLimited = false;

    outer: for (let aUnits = startAUnits; aUnits <= endAUnits; aUnits += effectiveStepUnits) {
      const domainBMaxUnits = limitUnits - aUnits;
      const bMaxUnits = maxBUnitsCap !== null && maxBUnitsCap < domainBMaxUnits ? maxBUnitsCap : domainBMaxUnits;
      const bMinCandidateUnits = aUnits + effectiveStepUnits;
      const bStartUnits = minBUnits !== null && minBUnits > bMinCandidateUnits ? minBUnits : bMinCandidateUnits;

      for (let bUnits = bStartUnits; bUnits <= bMaxUnits; bUnits += effectiveStepUnits) {
        cellsChecked++;
        sinceYield++;
        const { point, tested } = findValidPointInCell({
          centerAUnits: aUnits, centerBUnits: bUnits, userStepUnits, unitToDegrees, ringLimit,
          validateCandidate, baseLength, epsilon, domainLimitUnits: limitUnits,
        });
        candidatesTested += tested;
        if (point) points.push(point);

        if (sinceYield >= chunkTarget) {
          const elapsedMs = performance.now() - chunkStart;
          onProgress?.({ cellsChecked, found: points.length, done: false, cancelled: false });
          await yieldToEventLoop();
          if (cancelled) break outer;
          // Hard wall-clock backstop: whatever the actual per-cell cost
          // turns out to be for this particular view, never keep searching
          // past MAX_ADAPTIVE_RENDER_MS. See that constant's comment for
          // why the cell-count budget alone isn't sufficient.
          if (performance.now() - startedAt > MAX_ADAPTIVE_RENDER_MS) {
            timeLimited = true;
            break outer;
          }
          if (elapsedMs > 0) {
            const rescaled = Math.round(chunkTarget * (CELL_TIME_BUDGET_MS / elapsedMs));
            chunkTarget = Math.min(MAX_CELLS_PER_CHUNK, Math.max(MIN_CELLS_PER_CHUNK, rescaled));
          }
          sinceYield = 0;
          chunkStart = performance.now();
        }
      }
    }

    let result = dedupPointsByCell(points, dedupCellA, dedupCellB);
    // Independent of the cell budget above: if an unusually large fraction
    // of checked cells turned out valid (e.g. zoomed into the interior of a
    // large valid region), the found-point count could still exceed
    // MAX_VISIBLE_RENDER_POINTS. One extra, larger-celled dedup pass brings
    // it back under budget without an unbounded loop.
    if (result.length > MAX_VISIBLE_RENDER_POINTS) {
      const scaleFactor = Math.sqrt(result.length / MAX_VISIBLE_RENDER_POINTS);
      result = dedupPointsByCell(result, dedupCellA * scaleFactor, dedupCellB * scaleFactor);
    }

    if (excludePoint) {
      const halfA = dedupCellA / 2;
      const halfB = dedupCellB / 2;
      result = result.filter((p) => !isWithinRenderCell(p.a, p.b, excludePoint.a, excludePoint.b, halfA, halfB));
    }

    const durationMs = performance.now() - startedAt;
    if (DEBUG_ADAPTIVE_RENDERING) {
      console.log('[AdaptiveRender]', {
        zoomLevel, effectiveStepDegrees, requestedStepDegrees, stride, desiredStride, budgetLimited, timeLimited,
        viewportSize, cellsChecked, candidatesTested, pointsDrawn: result.length, durationMs: Math.round(durationMs), cancelled,
      });
    }

    onProgress?.({ cellsChecked, found: result.length, done: true, cancelled });
    return {
      points: result, effectiveStepDegrees, requestedStepDegrees, stride, budgetLimited, timeLimited,
      cellsChecked, candidatesTested, durationMs,
    };
  })();

  return { promise, cancel: () => { cancelled = true; } };
};
