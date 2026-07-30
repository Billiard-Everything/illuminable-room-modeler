// Shared helper for turning a fetched/known-exact geometry result into the
// same renderInfo shape and GraphCache entry every EXACT graph gets,
// regardless of how it arrived: AnglePlotWindow.jsx's own STEP 2b (a
// PostgreSQL hit found while plotting) and the Graph Library's "Load Graph"
// action (src/graphLibrary/useGraphLibrary.js) both call this instead of
// each building an equivalent object by hand — see this module's own
// introduction for why duplicating it was worth avoiding (identical shape,
// two very different call sites).
//
// Deliberately takes an already-known `hash` (never derives one itself):
// both call sites already have the authoritative hash on hand — STEP 2b
// from its own exactHash computation, the Graph Library from the metadata
// the browse/search API already returned — so re-deriving it here would
// only risk a caller accidentally passing mismatched params.

import { parseAngleStep, displayScaleForStep } from './angleStep.js';
import { RENDERER_MODE } from './rendererSelection.js';
import { GRAPH_STATUS } from './graphStatus.js';
import { graphCache } from './graphCache.js';

/**
 * Builds an EXACT renderInfo object and writes `{ points, renderInfo }`
 * into GraphCache under `hash`, so any future request for this exact graph
 * (a replot, a different row sharing the hash, or — for the Graph
 * Library's case — the very first job the newly-created row runs) hits
 * GraphCache's own STEP 2 check immediately instead of re-fetching or
 * recomputing.
 *
 * @param {string} hash - graphHasher.js's hashGraph output for this graph.
 * @param {string} angleStepInput - the graph's own Angle Step text (used to
 *   derive displayScale/stepDegrees for renderInfo — never to recompute
 *   the hash).
 * @param {{points: Array, durationMs: number|null}} geometryResult - as
 *   returned by remoteGraphRepository.js's fetchRemoteExactGraph.
 * @returns {object} the renderInfo that was cached, so a caller that also
 *   needs to patch its own row state (e.g. AnglePlotWindow's setRowResult)
 *   doesn't have to rebuild it a second time.
 */
export const primeExactGraphCache = (hash, angleStepInput, geometryResult) => {
  const parsed = parseAngleStep(angleStepInput);
  const renderInfo = {
    renderer: RENDERER_MODE.BRUTE_FORCE,
    graphStatus: GRAPH_STATUS.EXACT,
    userStepDegrees: parsed.valid ? parsed.stepDegrees : null,
    gridStepDegrees: parsed.valid ? parsed.stepDegrees : null,
    requestedStepDegrees: parsed.valid ? parsed.stepDegrees : null,
    displayScale: parsed.valid ? displayScaleForStep(parsed.scale) : 1,
    pointCount: geometryResult.points.length,
    durationMs: geometryResult.durationMs ?? null,
    budgetLimited: false,
    timeLimited: false,
  };
  graphCache.set(hash, { points: geometryResult.points, renderInfo });
  return renderInfo;
};
