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
// Lifecycle independence, and cancellation
// -------------------------------------------
// A job is tied to a *hash*, never to any single row — while two or more
// rows share identical parameters, both stay subscribed to the one running
// job, and neither's edit/deletion affects the other. requestExactComputation
// returns an unsubscribe function precisely so a caller can stop listening
// (on edit, deletion, or unmount) without necessarily disturbing anyone else
// still interested.
//
// But once the *last* subscriber for a hash unsubscribes — the common case
// of a single row being edited, deleted, or its window closed — the job is
// genuinely orphaned: nothing will ever read its result. Continuing to spend
// CPU on it would violate this feature's own requirement that "an outdated
// computation must immediately stop" and "a cancelled job must never write
// to GraphCache," so the last unsubscribe both cancels the underlying task
// (generateAngleRegion.js's own cooperative cancellation — see its
// `cancelled` flag, checked once per chunk) and evicts the job from this
// registry immediately, rather than waiting for the cancelled task to
// actually finish unwinding. Evicting immediately (not on eventual
// settlement) matters: a *new* request for the same hash arriving right
// after must start a fresh computation, not join a job that's already on
// its way out with no one left to deliver a result to.
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
 *   for this particular caller. If this was the last remaining subscriber
 *   for this hash, also cancels the underlying computation and evicts it
 *   from the registry (see the module comment above); with other
 *   subscribers still present, the job is left running for them untouched.
 */
export const requestExactComputation = (hash, computeFn, onResult) => {
  let job = activeJobs.get(hash);
  if (!job) {
    const task = computeFn();
    job = { task, subscribers: new Set() };
    activeJobs.set(hash, job);
    task.promise.then(
      (points) => {
        // A cancelled job is evicted synchronously by its last unsubscribe
        // (below), well before it actually settles — so by the time this
        // runs, `activeJobs.get(hash)` no longer points at `job` (it's
        // either gone, or a brand-new job for a later request of the same
        // hash). Guarding on identity here, not just presence, means this
        // never deletes a newer job that happens to share the hash, and
        // `job.subscribers` is already empty in the cancelled case, so the
        // forEach below is naturally a no-op — no update ever reaches the
        // UI or GraphCache for a cancelled computation.
        if (activeJobs.get(hash) === job) activeJobs.delete(hash);
        job.subscribers.forEach((subscriber) => subscriber(points, null));
      },
      (error) => {
        if (activeJobs.get(hash) === job) activeJobs.delete(hash);
        job.subscribers.forEach((subscriber) => subscriber(null, error));
      },
    );
  }
  job.subscribers.add(onResult);
  return () => {
    job.subscribers.delete(onResult);
    if (job.subscribers.size === 0 && activeJobs.get(hash) === job) {
      job.task.cancel();
      activeJobs.delete(hash);
    }
  };
};

/** True while a background exact computation for `hash` is in flight. */
export const isExactComputationRunning = (hash) => activeJobs.has(hash);

/** Test-only escape hatch: clears every tracked job without cancelling their underlying tasks. */
export const _resetForTests = () => activeJobs.clear();
