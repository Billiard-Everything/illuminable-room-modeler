// GraphStatus: the three lifecycle states a plotted Graph's geometry can be
// in (see graph.js for the Graph object shape itself). Kept as its own tiny
// module — rather than folded into graph.js or AnglePlotWindow.jsx — so any
// future file (a status badge component, a background worker, a database
// serializer) can import just this enum without pulling in anything else.
//
// PREVIEW    — the fast, viewport-scoped adaptive sampler's result. Shown
//              immediately; may not include every valid point in the domain.
// COMPUTING  — a PREVIEW is already on screen, and the exact brute-force
//              sweep for this same graph is running in the background (see
//              backgroundExactWorker.js). Purely informational: nothing
//              currently reads this to change behavior, but it exists so a
//              future "still refining…" indicator has a state to read.
// EXACT      — the full-domain brute-force sweep completed; this is the
//              final, complete answer for this graph's own parameters and
//              never needs recomputing again (see graphCache.js — an EXACT
//              entry is viewport-independent and cached under a hash that
//              omits the viewport for exactly this reason).
//
// The UI does not need to expose these yet (see AnglePlotPanel.jsx, which
// still only reads `points`) — they exist so it can, later, without any
// change to how a Graph's status is tracked.
export const GRAPH_STATUS = {
  PREVIEW: 'preview',
  COMPUTING: 'computing',
  EXACT: 'exact',
};
