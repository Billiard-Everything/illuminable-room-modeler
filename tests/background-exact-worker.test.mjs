import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestExactComputation, isExactComputationRunning, getBackgroundJobState,
  updateBackgroundJobPriority, JOB_PRIORITY, MAX_CONCURRENT_BACKGROUND_JOBS, _resetForTests,
} from '../src/anglePlot/backgroundExactWorker.js';

// A controllable task: resolve()/reject() are exposed so tests can decide
// exactly when the "computation" finishes, instead of racing real timers.
// `cancelCalls` tracks how many times `cancel()` was invoked, so tests can
// assert the real cancellation behavior (not just registry bookkeeping).
const deferredTask = () => {
  let resolve;
  let reject;
  let cancelCalls = 0;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {
    task: { promise, cancel: () => { cancelCalls += 1; } },
    resolve,
    reject,
    get cancelCalls() { return cancelCalls; },
  };
};

test.beforeEach(() => _resetForTests());

test('requestExactComputation calls computeFn once for a brand-new hash', () => {
  const { task, resolve } = deferredTask();
  let calls = 0;
  requestExactComputation('hash-a', () => { calls += 1; return task; }, () => {});
  assert.equal(calls, 1);
  resolve([]);
});

test('a second request for the same hash while one is in flight joins it instead of starting a new computation', () => {
  const { task } = deferredTask();
  let calls = 0;
  const computeFn = () => { calls += 1; return task; };
  requestExactComputation('hash-a', computeFn, () => {});
  requestExactComputation('hash-a', computeFn, () => {});
  requestExactComputation('hash-a', computeFn, () => {});
  assert.equal(calls, 1, 'computeFn should only ever be invoked once for a shared in-flight hash');
});

test('every subscriber for a hash is notified with the same result when the job resolves', async () => {
  const { task, resolve } = deferredTask();
  const seen = [];
  requestExactComputation('hash-a', () => task, (points) => seen.push(['first', points]));
  requestExactComputation('hash-a', () => task, (points) => seen.push(['second', points]));
  resolve(['pointA', 'pointB']);
  await task.promise;
  // Subscriber callbacks run in a microtask off the same promise; flush.
  await Promise.resolve();
  assert.deepEqual(seen, [
    ['first', ['pointA', 'pointB']],
    ['second', ['pointA', 'pointB']],
  ]);
});

test('a rejected computation notifies subscribers with the error, not a thrown exception', async () => {
  const { task, reject } = deferredTask();
  const seen = [];
  requestExactComputation('hash-a', () => task, (points, error) => seen.push([points, error]));
  const failure = new Error('boom');
  reject(failure);
  await task.promise.catch(() => {});
  await Promise.resolve();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], null);
  assert.equal(seen[0][1], failure);
});

test('unsubscribe stops that caller from being notified without affecting other subscribers', async () => {
  const job = deferredTask();
  const { task, resolve } = job;
  const seen = [];
  const unsubscribe = requestExactComputation('hash-a', () => task, () => seen.push('first'));
  requestExactComputation('hash-a', () => task, () => seen.push('second'));
  unsubscribe();
  assert.equal(job.cancelCalls, 0, 'a job with a remaining subscriber must not be cancelled');
  assert.equal(isExactComputationRunning('hash-a'), true);
  resolve([]);
  await task.promise;
  await Promise.resolve();
  assert.deepEqual(seen, ['second']);
});

test('unsubscribing the last remaining subscriber cancels the underlying task and evicts the job', () => {
  const job = deferredTask();
  const unsubscribe = requestExactComputation('hash-a', () => job.task, () => {});
  assert.equal(isExactComputationRunning('hash-a'), true);
  unsubscribe();
  assert.equal(job.cancelCalls, 1, 'the last unsubscribe must cancel the underlying computation');
  assert.equal(isExactComputationRunning('hash-a'), false, 'a cancelled job must be evicted from the registry immediately');
});

test('a cancelled job never notifies its own (now-unsubscribed) caller once it eventually settles', async () => {
  const { task, resolve } = deferredTask();
  let called = false;
  const unsubscribe = requestExactComputation('hash-a', () => task, () => { called = true; });
  unsubscribe();
  resolve(['late', 'result']);
  await task.promise;
  await Promise.resolve();
  assert.equal(called, false, 'a cancelled computation must never update the caller that cancelled it');
});

test('after the last subscriber cancels a job, a new request for the same hash starts a fresh computation rather than joining the cancelled one', () => {
  const first = deferredTask();
  const second = deferredTask();
  let calls = 0;
  const unsubscribe = requestExactComputation('hash-a', () => { calls += 1; return first.task; }, () => {});
  unsubscribe();
  requestExactComputation('hash-a', () => { calls += 1; return second.task; }, () => {});
  assert.equal(calls, 2, 'a cancelled+evicted job must never be joined by a later request for the same hash');
});

test('cancelling one subscriber of a shared job leaves it running for the remaining subscriber, which still gets notified', async () => {
  const job = deferredTask();
  const { task, resolve } = job;
  const seen = [];
  const unsubscribeFirst = requestExactComputation('hash-a', () => task, () => seen.push('first'));
  requestExactComputation('hash-a', () => task, () => seen.push('second'));
  unsubscribeFirst();
  assert.equal(job.cancelCalls, 0);
  resolve(['p']);
  await task.promise;
  await Promise.resolve();
  assert.deepEqual(seen, ['second']);
});

test('isExactComputationRunning reflects whether a hash currently has an in-flight job', async () => {
  const { task, resolve } = deferredTask();
  assert.equal(isExactComputationRunning('hash-a'), false);
  requestExactComputation('hash-a', () => task, () => {});
  assert.equal(isExactComputationRunning('hash-a'), true);
  resolve([]);
  await task.promise;
  await Promise.resolve();
  assert.equal(isExactComputationRunning('hash-a'), false);
});

test('two different hashes each get their own independent computation', () => {
  const { task: taskA } = deferredTask();
  const { task: taskB } = deferredTask();
  let callsA = 0;
  let callsB = 0;
  requestExactComputation('hash-a', () => { callsA += 1; return taskA; }, () => {});
  requestExactComputation('hash-b', () => { callsB += 1; return taskB; }, () => {});
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
});

test('a completed job is removed from the registry, so a later request for the same hash starts a fresh computation', async () => {
  const first = deferredTask();
  let calls = 0;
  requestExactComputation('hash-a', () => { calls += 1; return first.task; }, () => {});
  first.resolve([]);
  await first.task.promise;
  await Promise.resolve();

  const second = deferredTask();
  requestExactComputation('hash-a', () => { calls += 1; return second.task; }, () => {});
  assert.equal(calls, 2);
});

// --- Queue: worker limit, priority order, duplicate prevention ------------

test('MAX_CONCURRENT_BACKGROUND_JOBS is 2', () => {
  assert.equal(MAX_CONCURRENT_BACKGROUND_JOBS, 2);
});

test('only MAX_CONCURRENT_BACKGROUND_JOBS jobs run at once; extra requests queue instead of starting', () => {
  const jobs = [deferredTask(), deferredTask(), deferredTask()];
  jobs.forEach((job, i) => requestExactComputation(`hash-${i}`, () => job.task, () => {}));

  const states = jobs.map((_, i) => getBackgroundJobState(`hash-${i}`));
  const runningCount = states.filter((s) => s === 'running').length;
  const queuedCount = states.filter((s) => s === 'queued').length;
  assert.equal(runningCount, MAX_CONCURRENT_BACKGROUND_JOBS, 'no more than the worker limit may be running at once');
  assert.equal(queuedCount, 3 - MAX_CONCURRENT_BACKGROUND_JOBS, 'everything past the limit must be queued, not dropped');
});

test('when a running job finishes, the next queued job is automatically promoted to running', async () => {
  const jobs = [deferredTask(), deferredTask(), deferredTask()];
  jobs.forEach((job, i) => requestExactComputation(`hash-${i}`, () => job.task, () => {}));
  assert.equal(getBackgroundJobState('hash-2'), 'queued');

  const firstRunningIndex = jobs.findIndex((_, i) => getBackgroundJobState(`hash-${i}`) === 'running');
  jobs[firstRunningIndex].resolve([]);
  await jobs[firstRunningIndex].task.promise;
  await Promise.resolve();

  assert.equal(getBackgroundJobState('hash-2'), 'running', 'the queued job must be promoted the moment a slot frees');
});

test('a higher-priority queued job is promoted before a lower-priority one, regardless of insertion order', async () => {
  const running = [deferredTask(), deferredTask()];
  running.forEach((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));
  assert.equal(getBackgroundJobState('running-0'), 'running');
  assert.equal(getBackgroundJobState('running-1'), 'running');

  // Queue a low-priority (HIDDEN) request first, then a high-priority
  // (VISIBLE) one — insertion order alone would favor the hidden one.
  const hidden = deferredTask();
  const visible = deferredTask();
  requestExactComputation('hash-hidden', () => hidden.task, () => {}, JOB_PRIORITY.HIDDEN);
  requestExactComputation('hash-visible', () => visible.task, () => {}, JOB_PRIORITY.VISIBLE);
  assert.equal(getBackgroundJobState('hash-hidden'), 'queued');
  assert.equal(getBackgroundJobState('hash-visible'), 'queued');

  running[0].resolve([]);
  await running[0].task.promise;
  await Promise.resolve();

  assert.equal(getBackgroundJobState('hash-visible'), 'running', 'higher priority must be promoted first');
  assert.equal(getBackgroundJobState('hash-hidden'), 'queued', 'lower priority stays queued while a higher one is available');
});

test('within the same priority tier, the earliest-queued job is promoted first (FIFO)', async () => {
  const running = [deferredTask(), deferredTask()];
  running.forEach((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));

  const first = deferredTask();
  const second = deferredTask();
  requestExactComputation('hash-first', () => first.task, () => {}, JOB_PRIORITY.HIDDEN);
  requestExactComputation('hash-second', () => second.task, () => {}, JOB_PRIORITY.HIDDEN);

  running[0].resolve([]);
  await running[0].task.promise;
  await Promise.resolve();

  assert.equal(getBackgroundJobState('hash-first'), 'running');
  assert.equal(getBackgroundJobState('hash-second'), 'queued');
});

test('a duplicate request for an already-queued hash promotes its priority instead of creating a duplicate job', async () => {
  const running = [deferredTask(), deferredTask()];
  running.forEach((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));

  let calls = 0;
  const queued = deferredTask();
  requestExactComputation('hash-a', () => { calls += 1; return queued.task; }, () => {}, JOB_PRIORITY.HIDDEN);
  // A second, unrelated low-priority request queued after it, to prove the
  // promoted job jumps ahead of it once a slot frees.
  const otherQueued = deferredTask();
  requestExactComputation('hash-b', () => otherQueued.task, () => {}, JOB_PRIORITY.HIDDEN);

  // A duplicate request for the same hash, now at VISIBLE priority. Still
  // queued (no slot free yet), so computeFn has not run at all yet.
  requestExactComputation('hash-a', () => { calls += 1; return queued.task; }, () => {}, JOB_PRIORITY.VISIBLE);
  assert.equal(calls, 0, 'a still-queued job\'s computeFn must not run just because a duplicate request arrived');

  running[0].resolve([]);
  await running[0].task.promise;
  await Promise.resolve();

  assert.equal(getBackgroundJobState('hash-a'), 'running', 'the promoted job must be scheduled ahead of the still-HIDDEN one');
  assert.equal(getBackgroundJobState('hash-b'), 'queued');
  assert.equal(calls, 1, 'computeFn must run exactly once, only once the (single, deduped) job actually starts');
});

test('updateBackgroundJobPriority promotes an already-registered job without touching its subscribers or computeFn', async () => {
  const running = [deferredTask(), deferredTask()];
  running.forEach((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));

  let calls = 0;
  const seen = [];
  const queued = deferredTask();
  requestExactComputation('hash-a', () => { calls += 1; return queued.task; }, () => seen.push('a'), JOB_PRIORITY.HIDDEN);
  const other = deferredTask();
  requestExactComputation('hash-b', () => other.task, () => {}, JOB_PRIORITY.HIDDEN);

  updateBackgroundJobPriority('hash-a', JOB_PRIORITY.VISIBLE);
  assert.equal(calls, 0, 'updateBackgroundJobPriority must never call computeFn itself — the job is still only queued');
  assert.equal(seen.length, 0, 'and must never notify a subscriber either — no result exists yet');

  running[0].resolve([]);
  await running[0].task.promise;
  await Promise.resolve();

  assert.equal(getBackgroundJobState('hash-a'), 'running', 'the priority-promoted job must be scheduled first');
  assert.equal(calls, 1, 'computeFn must run exactly once, only once actually promoted to running');
});

test('updateBackgroundJobPriority never demotes an already-higher priority', async () => {
  const running = [deferredTask(), deferredTask()];
  running.forEach((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));

  const visible = deferredTask();
  const hidden = deferredTask();
  requestExactComputation('hash-visible', () => visible.task, () => {}, JOB_PRIORITY.VISIBLE);
  requestExactComputation('hash-hidden', () => hidden.task, () => {}, JOB_PRIORITY.HIDDEN);

  // Attempting to "demote" hash-visible must be a no-op.
  updateBackgroundJobPriority('hash-visible', JOB_PRIORITY.HIDDEN);

  running[0].resolve([]);
  await running[0].task.promise;
  await Promise.resolve();

  assert.equal(getBackgroundJobState('hash-visible'), 'running', 'a demotion attempt must never actually lower a job\'s priority');
});

test('unsubscribing the last listener of a still-QUEUED job drops it without ever calling computeFn', () => {
  const running = [deferredTask(), deferredTask()];
  running.forEach((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));

  let calls = 0;
  const queuedUnsubscribe = requestExactComputation('hash-a', () => { calls += 1; return deferredTask().task; }, () => {}, JOB_PRIORITY.HIDDEN);
  assert.equal(getBackgroundJobState('hash-a'), 'queued');

  queuedUnsubscribe();
  assert.equal(calls, 0, 'a job that never left the queue must never have its computeFn invoked');
  assert.equal(getBackgroundJobState('hash-a'), null, 'an unsubscribed queued job must be dropped from the registry entirely');
});

test('cancelling a running job frees its slot and promotes the next queued job', async () => {
  const running = [deferredTask(), deferredTask()];
  const unsubscribes = running.map((job, i) => requestExactComputation(`running-${i}`, () => job.task, () => {}, JOB_PRIORITY.VISIBLE));

  const queued = deferredTask();
  requestExactComputation('hash-a', () => queued.task, () => {}, JOB_PRIORITY.HIDDEN);
  assert.equal(getBackgroundJobState('hash-a'), 'queued');

  unsubscribes[0]();
  assert.equal(running[0].cancelCalls, 1, 'cancelling the last subscriber of a running job must call its cancel()');
  assert.equal(getBackgroundJobState('hash-a'), 'running', 'the queued job must be promoted immediately, synchronously, when a slot frees');
});
