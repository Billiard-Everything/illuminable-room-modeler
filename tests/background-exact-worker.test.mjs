import assert from 'node:assert/strict';
import test from 'node:test';
import { requestExactComputation, isExactComputationRunning, _resetForTests } from '../src/anglePlot/backgroundExactWorker.js';

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
