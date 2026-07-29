// Graph: the canonical shape every plotted sequence row is turned into for
// generation/caching/status-tracking purposes — see the task this file was
// introduced for: "every plotted graph should become a Graph object" with
// { id, hash, params, geometry, status, metadata }.
//
// Why a projection, not a parallel store
// -----------------------------------------
// AnglePlotWindow.jsx already keeps one authoritative per-row record in its
// `results` state ({ points, status: job-lifecycle, renderInfo, progress,
// error }), read by many existing call sites (row status text, the series
// builder AnglePlotPanel draws, GraphCache writes). Introducing a second,
// separate "Graph" store alongside it would mean keeping two copies of the
// same data in sync — exactly the kind of duplicated state that causes
// bugs. Instead, toGraph() below *projects* that existing record into the
// canonical Graph shape on demand: it is a read-only view, not new state,
// so there is nothing new to keep synchronized and nothing existing had to
// change shape to support it.
//
// `params` (sequenceText/angleA/angleB/angleStepInput/baseLength) plus
// `hash` (graphHasher.js's hashGraph — see AnglePlotWindow.jsx's own
// exactHash) together are a graph's stable, content-only identity: two rows
// with identical params always share the same hash, the same GraphCache
// entry, and the same background exact job (see backgroundExactWorker.js)
// — never two independent computations of the same answer.
//
// Database extension point (see server/repositories/graphRepository.js)
// -------------------------------------------------------------------------
// A Graph's shape here is already exactly what the `graphs` table row looks
// like: `hash` (graphHasher.js's hashGraph output) as the unique/primary
// key, `params` as the columns that produced it, `geometry` as the stored
// payload (see the `graph_geometry` table), and `status` as a plain enum
// column. Nothing in AnglePlotWindow.jsx needs to know that toGraph()
// currently reads from an in-memory `results` map instead of a database row
// — swapping the *source* this projects from is the only thing wiring up
// that repository would need to change here.

import { GRAPH_STATUS } from './graphStatus.js';

/**
 * Builds the plain `{sequenceText, angleA, angleB, angleStepInput,
 * baseLength}` parameter set that defines a graph's identity — the same
 * shape graphHasher.js's hashGraph hashes to produce a graph's `hash`, kept
 * as one function so nothing ever has to list these five fields out by
 * hand a second time.
 */
export const graphParamsFromSequence = (seq, baseLength) => ({
  sequenceText: seq.sequenceText,
  angleA: seq.angleA,
  angleB: seq.angleB,
  angleStepInput: seq.angleStepInput,
  baseLength,
});

/**
 * Projects a sequence row plus its AnglePlotWindow `results[id]` entry into
 * the canonical Graph shape. `hash` and `graphStatus` are passed in rather
 * than recomputed here since the caller (AnglePlotWindow.jsx) already has
 * both on hand at every call site that would need this.
 *
 * @returns {{id, hash, params, geometry: {points, renderInfo}, status, metadata}}
 */
export const toGraph = (seq, result, hash, baseLength) => ({
  id: seq.id,
  hash,
  params: graphParamsFromSequence(seq, baseLength),
  geometry: { points: result?.points ?? [], renderInfo: result?.renderInfo ?? null },
  status: result?.renderInfo?.graphStatus ?? GRAPH_STATUS.PREVIEW,
  metadata: {
    pointCount: result?.renderInfo?.pointCount ?? result?.points?.length ?? 0,
    durationMs: result?.renderInfo?.durationMs ?? null,
    fromCache: result?.renderInfo?.fromCache ?? false,
  },
});
