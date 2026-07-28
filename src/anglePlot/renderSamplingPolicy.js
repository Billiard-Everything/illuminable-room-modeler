// RenderSamplingPolicy: decides how finely the "Valid Angle A-B Region" plot
// should *display* the grid at the current zoom/viewport — a concern kept
// entirely separate from the Angle Step the user actually typed.
//
// Two separate concepts
// ----------------------
// - Angle Step (angleStep.js): the exact mathematical resolution the user
//   asked for. This module never reads or writes that field's stored value
//   — it only ever receives its parsed degree value as an input.
// - Render step (this module): a *display* resolution, recomputed from the
//   current zoom level and viewport size, used only to decide which
//   representative points to compute and draw right now. It is always an
//   exact whole-number *stride* over the Angle Step grid (see
//   calculateSamplingStride), so a coarser render step never departs from
//   the user's real grid — it only samples that grid less densely.
//
// Every Angle Step, however coarse or fine, renders through this adaptive
// policy and visibleAnglePointGenerator.js — there is no separate
// full-domain "exact" sweep mode.
//
// Zoom level definition
// ----------------------
// AnglePlotPanel stores zoom as screen pixels-per-degree (`zoom`), with
// `DEFAULT_ZOOM` pixels/degree at the initial/reset view. zoomLevel is
// simply that ratio, computed in AnglePlotPanel as `zoom / DEFAULT_ZOOM`:
// 1.0 at the default view, 2.0 at twice the magnification, 0.5 at half.
// Because AnglePlotPanel always uses the same pixels-per-degree value for
// both axes (so the region is never stretched — see its own comment), one
// zoomLevel covers both A and B; there is no independent zoomX/zoomY.

// Target on-screen spacing (px) between adjacent sampled grid points. This
// is the *only* thing that should drive fineness before the cell budget is
// applied — an earlier version of this module also had a separate
// "BASE_RENDER_STEP_DEGREES / zoomLevel" term meant to match this at
// zoom=1.0, but because pxPerDegree is itself proportional to zoomLevel,
// that term was mathematically proportional to this one at *every* zoom
// level, not just 1.0. It was silent dead weight, not a second constraint,
// and has been removed in favor of this single, direct pixel target.
export const TARGET_CELL_SIZE_PX = 2;

// Bounds on the *actual* projected pixel spacing once budget/stride
// rounding is applied — used by AnglePlotPanel to size dense-mode markers
// and occupancy-mode cells, not to choose the sampling step itself.
export const MIN_CELL_SIZE_PX = 1;
export const MAX_CELL_SIZE_PX = 24;

// Upper bound on how many coarse sample cells a single adaptive render is
// allowed to check. Chosen from live-measured throughput of this app's
// validator (see visibleAnglePointGenerator.js's chunking): dense regions
// (most candidates pass the cheap pre-checks and reach the expensive
// validator) sustain roughly 16k-26k checks/sec; sparse/mostly-invalid
// regions are much faster since most candidates are rejected before ever
// reaching the expensive validator. 200,000 cells keeps worst-case
// candidate volume (200,000 x MAX_CANDIDATES_PER_CELL) in the low tens of
// seconds even in the dense case, while comfortably covering the ~250x150
// cell counts a typical zoomed-in view needs for a solid appearance.
export const MAX_VISIBLE_SAMPLE_CELLS = 200_000;

// Separate hard cap on how many *found* representative points a render may
// return, independent of MAX_VISIBLE_SAMPLE_CELLS: a region that turns out
// to be almost entirely valid could otherwise return nearly one point per
// cell checked. generateVisibleAnglePoints applies one extra coarsening
// dedup pass if this is exceeded (see its own comment).
export const MAX_VISIBLE_RENDER_POINTS = 100_000;

// However fine the user's Angle Step is, never let the render step *itself*
// (before snapping to the user grid) get so coarse it collapses the whole
// 90-degree domain into a handful of cells.
export const MAX_RENDER_STEP_DEGREES = 15;

// Hard cap on how many of the user's exact grid points are tested while
// searching a single coarse cell for a representative valid point (see
// findValidPointInCell in visibleAnglePointGenerator.js). Bounds worst-case
// per-cell cost regardless of how large that cell is in grid-units.
export const MAX_CANDIDATES_PER_CELL = 9;

// How long to wait after the last zoom/pan/resize/Angle-Step change before
// actually regenerating points. Within the "avoid a render per wheel tick"
// window recommended for interactive debouncing.
export const RENDER_DEBOUNCE_MS = 200;

// Hard wall-clock cap on a single adaptive render, independent of
// MAX_VISIBLE_SAMPLE_CELLS. The cell budget assumes a validateCandidate
// throughput measured from one profiling run (~16k-26k checks/sec); a live
// test found a view where nearly every cell exhausted its full
// MAX_CANDIDATES_PER_CELL search without finding a valid point, at closer
// to ~200 cells/sec (~1,800 validateCandidate calls/sec) — at that rate,
// MAX_VISIBLE_SAMPLE_CELLS alone would let a single render run for many
// minutes. This is the actual responsiveness guarantee: whatever the
// per-candidate cost turns out to be for a given view, generateVisibleAnglePoints
// stops checking further cells once this much wall-clock time has elapsed
// and returns whatever it found so far (see the `timeLimited` result flag).
export const MAX_ADAPTIVE_RENDER_MS = 6000;

// Wall-clock backstop for the background *exact* brute-force sweep (see
// backgroundExactWorker.js), passed as generateAngleRegion's own
// `maxRenderMs` override. Deliberately much larger than
// MAX_ADAPTIVE_RENDER_MS: that constant protects a render the user is
// actively waiting on; this one protects a background task the user isn't
// waiting on at all, so it can be given far more real time before giving
// up and caching whatever partial result it found (still tagged
// `timeLimited`, same as the adaptive path) — the goal is "don't run
// forever and silently burn battery," not "stay within a UI-responsiveness
// budget."
export const MAX_BACKGROUND_EXACT_RENDER_MS = 60_000;

// Preload margin, expressed in effective render steps rather than a raw
// degree value, so points don't visibly pop in/out right at the viewport
// edge during a pan that hasn't triggered a new render yet.
export const VIEW_PRELOAD_MARGIN_STEPS = 2;

// Screen-pixel spacing used to deduplicate representative points that would
// otherwise land within the same small on-screen area (see
// dedupPointsByCell in visibleAnglePointGenerator.js). Deliberately smaller
// than TARGET_CELL_SIZE_PX so it only catches genuine near-duplicates (two
// cells whose ring search both happened to land close together) rather than
// discarding adjacent-but-distinct representative points.
export const POINT_DEDUP_PIXEL_SPACING = 1;

// Minimum visible world width/height, expressed in multiples of the user's
// Angle Step, that AnglePlotPanel will still allow zooming into (see its
// getMaxZoomPxPerDegree). Ties the zoom-in limit to when further zoom would
// stop revealing any additional mathematical detail, rather than an
// arbitrary pixel-based cap.
export const MIN_VISIBLE_GRID_STEPS = 8;

// Absolute sanity ceiling on zoom (screen pixels per degree), independent
// of Angle Step, purely to keep the panel's floating-point coordinate math
// (toScreenX/toDataA etc.) far away from double-precision underflow. Not
// expected to ever bind in practice — MIN_VISIBLE_GRID_STEPS binds first
// for any realistic Angle Step.
export const ABSOLUTE_MAX_ZOOM_PX_PER_DEGREE = 5_000_000;

// When true, generateVisibleAnglePoints logs one compact diagnostic line per
// completed render instead of staying silent. Off by default — this is a
// developer aid, not user-facing UI.
export const DEBUG_ADAPTIVE_RENDERING = false;

/**
 * Chooses the whole-number stride (a multiple of the user's exact Angle
 * Step) to sample at right now, given the current zoom level and viewport.
 * This is the one place that decision lives — callers should not
 * reimplement any part of it.
 *
 * Rule, in order:
 *  1. Desired on-screen spacing is TARGET_CELL_SIZE_PX. Convert that to a
 *     desired *degrees* spacing using the current px/degree, then to a
 *     stride by dividing by the user's Angle Step and rounding.
 *  2. Never below stride 1 (never finer than the user's real Angle Step —
 *     that is the true mathematical precision ceiling, not a display
 *     preference).
 *  3. Never above MAX_RENDER_STEP_DEGREES worth of stride.
 *  4. If that stride would still need more than MAX_VISIBLE_SAMPLE_CELLS
 *     sample cells for the current visible area, increase the stride
 *     (coarsen) until it fits the budget.
 *
 * Zoom itself is not a parameter here: `visibleWorldBounds` already reflects
 * the caller's current zoom level (a smaller visible width/height *is* what
 * "zoomed in" means — see AnglePlotPanel's toDataA/toDataB), so px/degree
 * derived from `viewportSize` and `visibleWorldBounds` together already
 * captures it exactly. Accepting a separate zoomLevel here in addition
 * would be redundant with whatever bounds the caller passed — exactly the
 * kind of silent double-counting that made an earlier version of this
 * module's fineness formula (BASE_RENDER_STEP_DEGREES / zoomLevel, layered
 * on top of a pixel-spacing floor that was already proportional to it)
 * misbehave without either term visibly being wrong on its own.
 *
 * @param {object} args
 * @param {number} args.userStepDegrees - the user's actual Angle Step, in degrees.
 * @param {{minA:number,maxA:number,minB:number,maxB:number}} args.visibleWorldBounds
 * @param {{width:number,height:number}} args.viewportSize - canvas size in CSS pixels.
 * @returns {{ stride: number, desiredStride: number, budgetLimited: boolean }}
 *   desiredStride is what pixel targeting alone would have chosen, before
 *   any budget-driven coarsening; budgetLimited is true when the budget
 *   forced `stride` above `desiredStride`.
 */
export const calculateSamplingStride = ({ userStepDegrees, visibleWorldBounds, viewportSize }) => {
  const worldWidth = Math.max(visibleWorldBounds.maxA - visibleWorldBounds.minA, 1e-9);
  const worldHeight = Math.max(visibleWorldBounds.maxB - visibleWorldBounds.minB, 1e-9);
  const pxPerDegreeX = Math.max(viewportSize.width, 1) / worldWidth;
  const pxPerDegreeY = Math.max(viewportSize.height, 1) / worldHeight;
  // The denser axis governs: a cell must stay >= TARGET_CELL_SIZE_PX on
  // *both* axes, so use whichever axis has more pixels per degree.
  const pxPerDegree = Math.max(pxPerDegreeX, pxPerDegreeY, 1e-9);

  const desiredStepDegrees = TARGET_CELL_SIZE_PX / pxPerDegree;
  const maxStride = Math.max(1, Math.round(MAX_RENDER_STEP_DEGREES / userStepDegrees));
  const desiredStride = Math.min(maxStride, Math.max(1, Math.round(desiredStepDegrees / userStepDegrees)));

  let stride = desiredStride;
  const stepDegrees = userStepDegrees * stride;
  const totalCells = (worldWidth / stepDegrees) * (worldHeight / stepDegrees);
  if (totalCells > MAX_VISIBLE_SAMPLE_CELLS) {
    stride = Math.min(maxStride, Math.max(desiredStride, Math.ceil(desiredStride * Math.sqrt(totalCells / MAX_VISIBLE_SAMPLE_CELLS))));
  }

  return { stride, desiredStride, budgetLimited: stride > desiredStride };
};

/**
 * Axis-aligned square (Chebyshev) containment test: true when the candidate
 * lies within halfCellWidth on A *and* halfCellHeight on B of the cell
 * center, independently on each axis — not a circular/Euclidean radius.
 * Used both for per-cell candidate searches and screen-space dedup.
 */
export const isWithinRenderCell = (candidateA, candidateB, cellCenterA, cellCenterB, halfCellWidth, halfCellHeight) => {
  const dx = Math.abs(candidateA - cellCenterA);
  const dy = Math.abs(candidateB - cellCenterB);
  return dx <= halfCellWidth && dy <= halfCellHeight;
};
