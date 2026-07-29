// GraphHasher: the one canonical, permanent identity hash for a graph.
//
// This is deliberately a separate module from graphCache.js's own
// buildGraphCacheKey, even though the two overlap: this hash is meant to
// become a graph's stable identifier across every layer that will ever
// need one — the in-memory GraphCache's EXACT entries, the background job
// queue's dedup key, and eventually a PostgreSQL `graphs.hash` column (see
// server/repositories/graphRepository.js) — so its own correctness and
// stability matter independently of whatever the *preview* cache's key
// shape happens to look like. graphCache.js's buildGraphCacheKey composes
// this hash with additional viewport-specific fields for its own
// viewport-scoped preview entries (see that file's own comment); this
// module has no notion of a viewport at all.
//
// What determines a graph's identity, and what deliberately doesn't
// -----------------------------------------------------------------------
// Included — every input that can change the *computed geometry* itself:
//   - the sequence code (exact text; even whitespace changes are a
//     different candidate-parsing input)
//   - Angle A / Angle B
//   - the Angle Step text, kept as the raw string rather than its parsed
//     numeric value — "0.10" and "0.1" are the same number but different
//     step *representations* worth distinguishing, exactly as
//     graphCache.js's own key already treats this field
//   - the shared base triangle length: not explicitly called out in this
//     feature's own field list, but omitting it would be a real bug, not
//     just an inefficiency — validateCandidate's result for a given
//     code/angle pair genuinely depends on it (a different triangle side
//     length can change which candidates are valid), so a hash that
//     ignored it would let a Base Geometry edit silently reuse another
//     length's now-wrong geometry
//   - GRAPH_HASH_ALGORITHM_VERSION: bumped whenever a change to the exact
//     brute-force sweep itself (generateAngleRegion.js) or the validation
//     it calls (angleValidation.js) would make an old hash's stored
//     geometry disagree with what a fresh computation now produces —
//     mirrors GRAPH_CACHE_ALGORITHM_VERSION's role in graphCache.js, but
//     kept as this module's own independent constant: a bug fix in the
//     *adaptive* preview sampler has no bearing on whether an already-
//     computed *exact* result is still correct, and vice versa, so tying
//     the two together would invalidate one algorithm's cached results
//     over a change to the other's.
//
// Deliberately excluded:
//   - Zoom, pan, viewport size — this hash identifies the *graph*, never
//     any particular view of it. The exact sweep this hash ultimately
//     identifies always covers the whole domain regardless of viewport
//     (see generateAngleRegion.js), so including any view state here would
//     only ever fragment one graph's identity across however many views a
//     user happened to be looking through when they requested it.
//   - Color, selection, active-row state, or any other UI/session state —
//     none of it is a computational input; two rows with identical
//     code/angles/step/length are the same graph, however differently
//     they happen to be displayed.
//   - Time, random values — a hash must be a pure function of its inputs
//     to be reusable as a permanent identifier at all; anything
//     time-based or random would defeat the entire point of hashing (the
//     same graph would never produce the same hash twice).
//   - The Angle Step spinner's UI increment (angleStepControlIncrementInput
//     in App.jsx) — purely a keyboard-arrow nudge amount for the input
//     element, never read by the generator, so it cannot change a single
//     bit of the output. Keying on it would only fragment the cache/DB
//     with duplicate rows for identical graphs, exactly as graphCache.js's
//     own key already establishes for the same reason.
export const GRAPH_HASH_ALGORITHM_VERSION = 1;

/**
 * The permanent, content-only identity hash for a graph. Deterministic and
 * pure: the same inputs always produce the same string, and nothing here
 * ever reads the clock, a random source, or any view/UI state.
 *
 * @param {object} params
 * @param {string} params.sequenceText - the exact code, whitespace included.
 * @param {number|string} params.angleA
 * @param {number|string} params.angleB
 * @param {string} params.angleStepInput - the raw Angle Step text (not a parsed number).
 * @param {number|string} params.baseLength - the shared base triangle length.
 * @returns {string}
 */
export const hashGraph = ({ sequenceText, angleA, angleB, angleStepInput, baseLength }) => {
  const num = (value) => Number(value).toString();
  return [
    `alg${GRAPH_HASH_ALGORITHM_VERSION}`,
    `code(${sequenceText})`,
    `a(${num(angleA)})`,
    `b(${num(angleB)})`,
    `step(${angleStepInput})`,
    `len(${num(baseLength)})`,
  ].join('|');
};
