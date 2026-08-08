import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelRecoveryProbe, readModelStatus } from '../src/model-probe.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function trackSettlement(promise) {
  let settled = false;
  promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  return () => settled;
}

function modelResponse(status) {
  return {
    ok: true,
    json: async () => ({ services: [{ model: 'target', last: { ok: status } }] })
  };
}

function createScheduler() {
  const timers = [];
  const cancelled = [];
  return {
    timers,
    cancelled,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      cancelled.push(timer);
    }
  };
}

function createProbe({ replies = [], fetchImpl, intervalMs = 30_000, requestTimeoutMs = 4_000 } = {}) {
  const scheduler = createScheduler();
  const warnings = [];
  let requestCount = 0;
  const probe = new ModelRecoveryProbe({
    url: 'http://probe',
    targetModel: 'target',
    intervalMs,
    requestTimeoutMs,
    fetchImpl: async (...args) => {
      requestCount += 1;
      if (fetchImpl) return fetchImpl(...args);
      const reply = replies.shift();
      return typeof reply === 'function' ? reply() : modelResponse(reply);
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    logger: { warn: (...args) => warnings.push(args) }
  });
  return {
    probe,
    timers: scheduler.timers,
    cancelled: scheduler.cancelled,
    warnings,
    requestCount: () => requestCount
  };
}

async function fireTimer(timer) {
  timer.callback();
  await flushAsyncWork();
}

test('readModelStatus uses exact model matching and accepts only boolean last.ok', () => {
  const payload = {
    services: [
      { model: 'other', last: { ok: true } },
      { model: 'target', last: { ok: false } }
    ]
  };

  assert.equal(readModelStatus(payload, 'target'), false);
  assert.equal(readModelStatus(payload, 'tar'), null);
  assert.equal(readModelStatus({ services: [{ model: 'target', last: { ok: 1 } }] }, 'target'), null);
  assert.equal(readModelStatus({ services: [{ model: 'target' }] }, 'target'), null);
  assert.equal(readModelStatus({ services: 'invalid' }, 'target'), null);
  assert.equal(readModelStatus(null, 'target'), null);
});

test('start establishes the lifecycle without making a request', async () => {
  const { probe, timers, requestCount } = createProbe({ replies: [true] });
  const recovery = probe.waitForRecovery();
  recovery.catch(() => {});

  probe.start();
  await flushAsyncWork();

  assert.equal(requestCount(), 0);
  assert.equal(timers.length, 0);
  probe.close();
  await assert.rejects(recovery, /closed/);
});

test('confirms health with two interval-separated true samples', async () => {
  const { probe, timers, requestCount } = createProbe({ replies: [true, true] });
  probe.start();
  const recovery = probe.waitForRecovery();
  const isSettled = trackSettlement(recovery);

  probe.beginRecoveryCheck();
  await flushAsyncWork();

  assert.equal(requestCount(), 1);
  assert.equal(isSettled(), false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 30_000);

  await fireTimer(timers[0]);

  assert.equal(await recovery, 'confirmed-healthy');
  assert.equal(timers.length, 1);
  probe.close();
});

test('false then true resolves as recovered-after-false', async () => {
  const { probe, timers } = createProbe({ replies: [false, true] });
  const recovery = probe.waitForRecovery();

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  await fireTimer(timers[0]);

  assert.equal(await recovery, 'recovered-after-false');
  probe.close();
});

test('true then unknown requires two subsequent true samples', async () => {
  const { probe, timers, warnings } = createProbe({ replies: [true, null, true, true] });
  const recovery = probe.waitForRecovery();
  const isSettled = trackSettlement(recovery);

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  await fireTimer(timers[0]);
  await fireTimer(timers[1]);

  assert.equal(isSettled(), false);
  assert.equal(warnings.length, 1);

  await fireTimer(timers[2]);

  assert.equal(await recovery, 'confirmed-healthy');
  probe.close();
});

test('false then unknown then true resolves as recovered-after-false', async () => {
  const { probe, timers } = createProbe({ replies: [false, null, true] });
  const recovery = probe.waitForRecovery();

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  await fireTimer(timers[0]);
  await fireTimer(timers[1]);

  assert.equal(await recovery, 'recovered-after-false');
  probe.close();
});

test('beginRecoveryCheck after ready starts a fresh confirmation cycle', async () => {
  const { probe, timers } = createProbe({ replies: [true, true, true, true] });
  const firstRecovery = probe.waitForRecovery();

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  await fireTimer(timers[0]);
  assert.equal(await firstRecovery, 'confirmed-healthy');
  assert.equal(await probe.waitForRecovery(), 'confirmed-healthy');

  probe.beginRecoveryCheck();
  const secondRecovery = probe.waitForRecovery();
  const isSettled = trackSettlement(secondRecovery);
  await flushAsyncWork();

  assert.equal(isSettled(), false);
  await fireTimer(timers[1]);
  assert.equal(await secondRecovery, 'confirmed-healthy');
  probe.close();
});

test('schedules each poll only after the active poll completes', async () => {
  const firstResponse = deferred();
  const secondResponse = deferred();
  const responses = [firstResponse, secondResponse];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const { probe, timers, requestCount } = createProbe({
    intervalMs: 123,
    fetchImpl: async () => {
      const response = responses.shift();
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        return await response.promise;
      } finally {
        activeRequests -= 1;
      }
    }
  });
  const recovery = probe.waitForRecovery();

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  assert.equal(requestCount(), 1);
  assert.equal(activeRequests, 1);
  assert.equal(timers.length, 0);

  firstResponse.resolve(modelResponse(false));
  await flushAsyncWork();
  assert.equal(activeRequests, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 123);

  timers[0].callback();
  await flushAsyncWork();
  assert.equal(requestCount(), 2);
  assert.equal(activeRequests, 1);
  assert.equal(timers.length, 1);

  secondResponse.resolve(modelResponse(true));
  await flushAsyncWork();
  assert.equal(maximumActiveRequests, 1);
  assert.equal(await recovery, 'recovered-after-false');
  probe.close();
});

test('a superseding cycle cancels the previous timer', async () => {
  const { probe, timers, cancelled } = createProbe({ replies: [false, true, true] });

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  const oldTimer = timers[0];

  probe.beginRecoveryCheck();
  const recovery = probe.waitForRecovery();
  await flushAsyncWork();

  assert.deepEqual(cancelled, [oldTimer]);
  await fireTimer(timers[1]);
  assert.equal(await recovery, 'confirmed-healthy');
  probe.close();
});

test('a superseding cycle aborts and ignores an old active result', async () => {
  const oldResponse = deferred();
  const signals = [];
  let requestCount = 0;
  const { probe, timers, warnings } = createProbe({
    fetchImpl: async (_url, { signal }) => {
      signals.push(signal);
      requestCount += 1;
      if (requestCount === 1) return oldResponse.promise;
      return modelResponse(true);
    }
  });
  const recovery = probe.waitForRecovery();

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  probe.beginRecoveryCheck();
  await flushAsyncWork();

  assert.equal(signals[0].aborted, true);
  oldResponse.resolve(modelResponse(false));
  await flushAsyncWork();
  await fireTimer(timers[0]);

  assert.equal(await recovery, 'confirmed-healthy');
  assert.deepEqual(warnings, []);
  probe.close();
});

test('a superseding cycle suppresses warnings from an old active request', async () => {
  const oldResponse = deferred();
  let requestCount = 0;
  const { probe, timers, warnings } = createProbe({
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) return oldResponse.promise;
      return modelResponse(true);
    }
  });
  const recovery = probe.waitForRecovery();

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  probe.beginRecoveryCheck();
  await flushAsyncWork();
  oldResponse.reject(new Error('stale failure'));
  await flushAsyncWork();
  await fireTimer(timers[0]);

  assert.equal(await recovery, 'confirmed-healthy');
  assert.deepEqual(warnings, []);
  probe.close();
});

const failureCases = [
  {
    name: 'an HTTP failure',
    expectedMessage: 'HTTP request failed: 503',
    response: async () => ({ ok: false, status: 503 })
  },
  {
    name: 'a thrown fetch failure',
    expectedMessage: 'offline',
    response: async () => { throw new Error('offline'); }
  },
  {
    name: 'malformed JSON',
    expectedMessage: 'invalid JSON',
    response: async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('invalid JSON'); }
    })
  },
  {
    name: 'an invalid model status',
    expectedMessage: 'model status is unknown',
    response: async () => modelResponse('yes')
  },
  {
    name: 'a missing model status',
    expectedMessage: 'model status is unknown',
    response: async () => ({ ok: true, json: async () => ({ services: [] }) })
  }
];

for (const failureCase of failureCases) {
  test(`${failureCase.name} warns once and counts as unknown`, async () => {
    const { probe, timers, warnings } = createProbe({
      replies: [false, failureCase.response, true]
    });
    const recovery = probe.waitForRecovery();
    const isSettled = trackSettlement(recovery);

    probe.beginRecoveryCheck();
    await flushAsyncWork();
    await fireTimer(timers[0]);

    assert.equal(isSettled(), false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].length, 1);
    assert.match(warnings[0][0], /target/);
    assert.match(warnings[0][0], new RegExp(failureCase.expectedMessage));

    await fireTimer(timers[1]);
    assert.equal(await recovery, 'recovered-after-false');
    probe.close();
  });
}

test('request timeout aborts the fetch and counts as unknown', async () => {
  let requestSignal;
  const { probe, warnings } = createProbe({
    requestTimeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  });

  assert.equal(await probe.checkNow(), null);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason?.name, 'TimeoutError');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].length, 1);
  probe.close();
});

test('close cancels a scheduled poll and rejects pending waiters', async () => {
  const { probe, timers, cancelled } = createProbe({ replies: [false] });
  const recovery = probe.waitForRecovery();
  recovery.catch(() => {});

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  probe.close();

  assert.deepEqual(cancelled, [timers[0]]);
  await assert.rejects(recovery, /closed/);
  probe.close();
});

test('close aborts active requests and suppresses late activity', async () => {
  const response = deferred();
  let requestSignal;
  const { probe, timers, warnings } = createProbe({
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return response.promise;
    }
  });
  const recovery = probe.waitForRecovery();
  recovery.catch(() => {});

  probe.beginRecoveryCheck();
  await flushAsyncWork();
  probe.close();
  assert.equal(requestSignal.aborted, true);

  response.reject(new Error('late failure'));
  await flushAsyncWork();

  assert.deepEqual(timers, []);
  assert.deepEqual(warnings, []);
  await assert.rejects(recovery, /closed/);
});
