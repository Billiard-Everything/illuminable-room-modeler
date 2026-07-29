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
// running (or already queued — see below).
//
// A bounded queue, not unlimited concurrency
// ---------------------------------------------
// Every brute-force sweep is a chunked, cooperatively-yielding loop on the
// single JS thread (generateAngleRegion.js) — there is no real parallelism
// to gain by running many of them "at once," and doing so just means more
// tasks time-slicing the same thread, each taking proportionally longer to
// finish (observed directly while stress-testing the cancellation feature:
// three interleaved sweeps took ~5x longer apiece than one running alone).
// So only MAX_CONCURRENT_BACKGROUND_JOBS jobs are ever actually running at
// once; everything else sits queued until a running slot frees up, at which
// point the highest-priority still-queued job is promoted automatically.
//
// Priority
// ---------
// AnglePlotWindow.jsx assigns each request one of JOB_PRIORITY's four tiers
// (lower number = more urgent = dequeued first), reflecting what's actually
// worth spending the two available slots on right now: a graph currently on
// screen, then the one selected for the main canvas, then a graph that was
// just freshly plotted (even if not shown), and last, any other hidden
// graph's job. A duplicate request for an already-queued hash can *promote*
// its priority (see requestExactComputation) but never demotes it — a job
// already queued at a high priority stays there even if a later, lower-
// priority subscriber also joins it.
//
// Lifecycle independence, and cancellation
// -------------------------------------------
// A job is tied to a *hash*, never to any single row — while two or more
// rows share identical parameters, both stay subscribed to the one job
// (queued or running), and neither's edit/deletion affects the other.
// requestExactComputation returns an unsubscribe function precisely so a
// caller can stop listening (on edit, deletion, or unmount) without
// necessarily disturbing anyone else still interested.
//
// But once the *last* subscriber for a hash unsubscribes — the common case
// of a single row being edited, deleted, or its window closed — the job is
// genuinely orphaned: nothing will ever read its result. A still-queued
// job is simply dropped from the queue (it never even started, so there is
// nothing to cancel); a running job is cancelled outright (generateAngleRegion.js's
// own cooperative cancellation — see its `cancelled` flag, checked once per
// chunk) and its slot is immediately handed to the next queued job. Both
// cases evict the job from the registry synchronously, not on eventual
// settlement: a *new* request for the same hash arriving right after must
// start a fresh computation, not join a job that's already on its way out
// with no one left to deliver a result to.
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

// Highest urgency first (lower number = scheduled sooner). See the module
// comment's "Priority" section for what each tier means.
export const JOB_PRIORITY = {
  VISIBLE: 0,
  SELECTED: 1,
  NEWLY_PLOTTED: 2,
  HIDDEN: 3,
};

// Only this many brute-force sweeps ever run at once; every other request
// waits in the priority queue. See the module comment's "A bounded queue"
// section for why more concurrency doesn't actually help here.
export const MAX_CONCURRENT_BACKGROUND_JOBS = 2;

// hash -> {
//   computeFn, subscribers: Set<(points, error) => void>, priority: number,
//   order: number (insertion sequence, for FIFO tie-breaking within a
//     priority tier), status: 'queued'|'running', task: {promise, cancel}|null
// }
const jobs = new Map();
let runningCount = 0;
let insertionCounter = 0;

// Promotes queued jobs into running slots, highest priority (then earliest
// insertion order) first, until every slot is full or nothing is left
// queued. Called after every registration, cancellation, and completion —
// it is always safe to call redundantly (a no-op when there's no free slot
// or nothing queued), so callers never need to reason about exactly when a
// slot became available.
const pump = () => {
  while (runningCount < MAX_CONCURRENT_BACKGROUND_JOBS) {
    let nextHash = null;
    let nextJob = null;
    for (const [hash, job] of jobs) {
      if (job.status !== 'queued') continue;
      if (!nextJob || job.priority < nextJob.priority
        || (job.priority === nextJob.priority && job.order < nextJob.order)) {
        nextHash = hash;
        nextJob = job;
      }
    }
    if (!nextJob) break;
    nextJob.status = 'running';
    runningCount += 1;
    nextJob.task = nextJob.computeFn();
    nextJob.task.promise.then(
      (points) => finishJob(nextHash, nextJob, points, null),
      (error) => finishJob(nextHash, nextJob, null, error),
    );
  }
};

const finishJob = (hash, job, points, error) => {
  // A cancelled job is evicted (and runningCount decremented) synchronously
  // by its last unsubscribe (below), well before it actually settles — so
  // by the time this runs, `jobs.get(hash)` no longer points at `job` (it's
  // either gone, or a brand-new job for a later request of the same hash).
  // Guarding on identity here, not just presence, means this never deletes
  // a newer job that happens to share the hash or double-decrements
  // runningCount, and `job.subscribers` is already empty in the cancelled
  // case, so the forEach below is naturally a no-op — no update ever
  // reaches the UI or GraphCache for a cancelled computation.
  if (jobs.get(hash) === job) {
    jobs.delete(hash);
    runningCount -= 1;
  }
  job.subscribers.forEach((subscriber) => subscriber(points, error));
  pump();
};

/**
 * Requests (or joins) the background exact computation for `hash`.
 *
 * @param {string} hash - a graph's stable, content-only identity (see
 *   graph.js's graphParamsFromSequence + graphCache.js's buildGraphCacheKey
 *   called without a viewport).
 * @param {() => {promise: Promise<any>, cancel: () => void}} computeFn -
 *   factory for the actual computation; called at most once per hash, only
 *   once that hash reaches the front of the queue with a free running
 *   slot. Deferred behind a function (not called eagerly) so joining an
 *   already-queued/running job never pays the cost of constructing a
 *   redundant task, and a job that never leaves the queue before being
 *   cancelled never runs at all.
 * @param {(points: any, error: Error|null) => void} onResult - called
 *   once, when the (possibly shared) job for this hash settles. `points`
 *   is generateAngleRegion's resolved array; `error` is set instead if the
 *   computation itself threw.
 * @param {number} [priority] - one of JOB_PRIORITY; defaults to the lowest
 *   (HIDDEN) if omitted. A request for an already-queued hash can promote
 *   its priority (never demote it) — see updateBackgroundJobPriority for
 *   updating priority without adding a new subscriber.
 * @returns {() => void} unsubscribe — stops `onResult` from being called
 *   for this particular caller. If this was the last remaining subscriber
 *   for this hash: a still-queued job is simply dropped (never started);
 *   a running job is cancelled outright and its slot handed to the next
 *   queued job. With other subscribers still present, the job (queued or
 *   running) is left exactly as it was for them.
 */
export const requestExactComputation = (hash, computeFn, onResult, priority = JOB_PRIORITY.HIDDEN) => {
  let job = jobs.get(hash);
  if (!job) {
    job = { computeFn, subscribers: new Set(), priority, order: insertionCounter++, status: 'queued', task: null };
    jobs.set(hash, job);
  } else if (priority < job.priority) {
    job.priority = priority;
  }
  job.subscribers.add(onResult);
  pump();
  return () => {
    job.subscribers.delete(onResult);
    if (job.subscribers.size > 0 || jobs.get(hash) !== job) return;
    if (job.status === 'queued') {
      jobs.delete(hash);
      return;
    }
    job.task.cancel();
    jobs.delete(hash);
    runningCount -= 1;
    pump();
  };
};

/**
 * Promotes (never demotes) the priority of an already-registered job for
 * `hash`, without adding or removing any subscriber. Use this when a row
 * that's already subscribed to an unchanged hash has a state change that
 * could raise its urgency (e.g. it just became visible or selected) — a
 * full unsubscribe/resubscribe isn't needed just to update this, and would
 * pointlessly cancel-and-restart an already-correct running job. A no-op
 * if `hash` has no registered job.
 */
export const updateBackgroundJobPriority = (hash, priority) => {
  const job = jobs.get(hash);
  if (job && priority < job.priority) job.priority = priority;
};

/** True while a background exact computation for `hash` is registered, queued or running. */
export const isExactComputationRunning = (hash) => jobs.has(hash);

/** 'queued' | 'running' | null (no job registered) for `hash`. */
export const getBackgroundJobState = (hash) => jobs.get(hash)?.status ?? null;

/** Test-only escape hatch: clears every tracked job without cancelling their underlying tasks. */
export const _resetForTests = () => {
  jobs.clear();
  runningCount = 0;
};
