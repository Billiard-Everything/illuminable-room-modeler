// BackgroundExactWorker: runs the exact brute-force sweep (generateAngleRegion.js)
// for a graph in the background, deduped by graph hash, decoupled from any
// specific row/component — this is the "Background worker" the graph-cache
// architecture explicitly calls out as its own concern, separate from
// generation (generateAngleRegion.js), renderer selection
// (rendererSelection.js), and the cache itself (graphCache.js).
//
// Why a module-level registry, not per-row state
// -------------------------------------------------
// Two sequence rows with identical parameters (same code, angles, step,
// base length) hash to the same graph identity (see graph.js) and should
// only ever pay for ONE exact computation between them — never two
// independent brute-force sweeps computing the same answer. A registry
// keyed by hash, living outside any single component's state, is what
// makes that possible: whichever row's request arrives first starts the
// job; every subsequent request for the same hash — from the same row on
// a later render, from a different row with identical params, or from a
// row that was hidden and re-shown — just subscribes to the one already
// running.
//
// Lifecycle independence
// -------------------------
// A job is tied to a *hash*, never to the row(s) that happened to trigger
// it. If every subscribed row is deleted or edited to a different
// configuration before the job finishes, the job still runs to completion
// and still populates GraphCache — a future row (or a future session, once
// a persistent backend replaces the in-memory cache) with the same exact
// parameters still benefits from it. requestExactComputation returns an
// unsubscribe function precisely so a caller can stop listening (e.g. on
// unmount, to avoid calling setState on a gone component) without
// cancelling the underlying computation for anyone else still interested.
//
// Extension point for Stage 3 (persistent storage, not implemented here)
// ---------------------------------------------------------------------------
// This module never touches GraphCache directly — the caller decides what
// to do with a finished result (AnglePlotWindow.jsx both writes it to
// GraphCache and updates the triggering row's displayed geometry). A
// future backend-backed job queue (e.g. a real worker/server process
// computing exact graphs asynchronously) would only need to change what
// `computeFn` does and how a result eventually arrives — the
// register/subscribe/notify contract below stays the same either way.

// hash -> { task: {promise, cancel}, subscribers: Set<(points, error) => void> }
const activeJobs = new Map();

/**
 * Starts (or joins) the background exact computation for `hash`.
 *
 * @param {string} hash - a graph's stable, content-only identity (see
 *   graph.js's graphParamsFromSequence + graphCache.js's buildGraphCacheKey
 *   called without a viewport).
 * @param {() => {promise: Promise<any>, cancel: () => void}} computeFn -
 *   factory for the actual computation; called at most once per hash,
 *   only when no job for that hash is already running. Deferred behind a
 *   function (not called eagerly) so joining an already-running job never
 *   pays the cost of constructing a redundant task.
 * @param {(points: any, error: Error|null) => void} onResult - called
 *   once, when the (possibly shared) job for this hash settles. `points`
 *   is generateAngleRegion's resolved array; `error` is set instead if the
 *   computation itself threw.
 * @returns {() => void} unsubscribe — stops `onResult` from being called
 *   for this particular caller; does not cancel the job for any other
 *   subscriber.
 */
export const requestExactComputation = (hash, computeFn, onResult) => {
  let job = activeJobs.get(hash);
  if (!job) {
    const task = computeFn();
    job = { task, subscribers: new Set() };
    activeJobs.set(hash, job);
    task.promise.then(
      (points) => {
        activeJobs.delete(hash);
        job.subscribers.forEach((subscriber) => subscriber(points, null));
      },
      (error) => {
        activeJobs.delete(hash);
        job.subscribers.forEach((subscriber) => subscriber(null, error));
      },
    );
  }
  job.subscribers.add(onResult);
  return () => job.subscribers.delete(onResult);
};

/** True while a background exact computation for `hash` is in flight. */
export const isExactComputationRunning = (hash) => activeJobs.has(hash);

/** Test-only escape hatch: clears every tracked job without cancelling their underlying tasks. */
export const _resetForTests = () => activeJobs.clear();
