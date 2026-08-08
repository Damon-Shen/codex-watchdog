import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelRecoveryProbe, readModelStatus } from '../src/model-probe.mjs';

function stateProbe() {
  let status;
  const probe = new ModelRecoveryProbe({
    url: 'http://probe',
    targetModel: 'target',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ services: [{ model: 'target', last: { ok: status } }] })
    }),
    logger: { warn() {} }
  });
  return {
    probe,
    sample: async (nextStatus) => {
      status = nextStatus;
      return probe.checkNow();
    }
  };
}

function modelResponse(status) {
  return {
    ok: true,
    json: async () => ({ services: [{ model: 'target', last: { ok: status } }] })
  };
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

test('initial true does not resolve a recovery waiter', async () => {
  const { probe, sample } = stateProbe();
  let settled = false;
  const waiter = probe.waitForRecovery();
  waiter.then(() => { settled = true; }, () => {});

  await sample(true);
  await Promise.resolve();
  assert.equal(settled, false);
  probe.close();
  await assert.rejects(waiter, /closed/);
});

test('false then true resolves the recovery waiter', async () => {
  const { probe, sample } = stateProbe();
  const waiter = probe.waitForRecovery();

  await sample(false);
  await sample(true);
  await assert.doesNotReject(waiter);
  probe.close();
});

test('an unknown sample between false and true does not clear the outage', async () => {
  const { probe, sample } = stateProbe();
  const waiter = probe.waitForRecovery();

  await sample(false);
  await sample(null);
  let settled = false;
  waiter.then(() => { settled = true; }, () => {});
  await Promise.resolve();
  assert.equal(settled, false);
  await sample(true);
  await assert.doesNotReject(waiter);
  probe.close();
});

test('recovered state resolves a new waiter immediately', async () => {
  const { probe, sample } = stateProbe();
  await sample(false);
  await sample(true);

  await assert.doesNotReject(probe.waitForRecovery());
  probe.close();
});

test('a later false requires another true', async () => {
  const { probe, sample } = stateProbe();
  await sample(false);
  await sample(true);
  await sample(false);

  let settled = false;
  const waiter = probe.waitForRecovery();
  waiter.then(() => { settled = true; }, () => {});
  await Promise.resolve();
  assert.equal(settled, false);
  await sample(true);
  await assert.doesNotReject(waiter);
  probe.close();
});

test('start polls immediately and schedules only after the request completes', async () => {
  const scheduled = [];
  let resolveFetch;
  const fetchStarted = new Promise((resolve) => { resolveFetch = resolve; });
  const fetchImpl = async () => {
    resolveFetch();
    await new Promise((resolve) => { resolveFetch = resolve; });
    return { ok: true, json: async () => ({ services: [{ model: 'target', last: { ok: false } }] }) };
  };
  const probe = new ModelRecoveryProbe({
    url: 'http://probe',
    targetModel: 'target',
    intervalMs: 123,
    fetchImpl,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    }
  });

  probe.start();
  await fetchStarted;
  assert.equal(scheduled.length, 0);
  resolveFetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 123);
  probe.close();
});

test('close cancels polling and rejects a pending waiter', async () => {
  const scheduled = [];
  const cancelled = [];
  const probe = new ModelRecoveryProbe({
    url: 'http://probe',
    targetModel: 'target',
    fetchImpl: async () => ({ ok: true, json: async () => ({ services: [{ model: 'target', last: { ok: false } }] }) }),
    schedule: (callback) => {
      scheduled.push(callback);
      return 99;
    },
    cancel: (handle) => cancelled.push(handle)
  });
  const waiter = probe.waitForRecovery();

  probe.start();
  await new Promise((resolve) => setImmediate(resolve));
  probe.close();
  assert.deepEqual(cancelled, [99]);
  await assert.rejects(waiter, /closed/);
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
  test(`a down outage survives ${failureCase.name}`, async () => {
    const warnings = [];
    let requestCount = 0;
    const probe = new ModelRecoveryProbe({
      url: 'http://probe',
      targetModel: 'target',
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) return modelResponse(false);
        if (requestCount === 2) return failureCase.response();
        return modelResponse(true);
      },
      logger: { warn: (...args) => warnings.push(args) }
    });
    const waiter = probe.waitForRecovery();
    let settled = false;
    waiter.then(() => { settled = true; }, () => {});

    assert.equal(await probe.checkNow(), false);
    assert.equal(await probe.checkNow(), null);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(await probe.checkNow(), true);
    await assert.doesNotReject(waiter);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].length, 1);
    assert.match(warnings[0][0], /target/);
    assert.match(warnings[0][0], new RegExp(failureCase.expectedMessage));
    probe.close();
  });
}

test('close aborts active requests without logging or accepting late results', async () => {
  const warnings = [];
  const activeSignals = [];
  let resolveLateRequest;
  let rejectAbortRequest;
  let notifyRequestsStarted;
  const requestsStarted = new Promise((resolve) => { notifyRequestsStarted = resolve; });
  let requestCount = 0;
  const probe = new ModelRecoveryProbe({
    url: 'http://probe',
    targetModel: 'target',
    fetchImpl: async (_url, { signal }) => {
      requestCount += 1;
      if (requestCount === 1) return modelResponse(false);
      activeSignals.push(signal);
      if (activeSignals.length === 2) notifyRequestsStarted();
      if (requestCount === 2) {
        return new Promise((resolve) => { resolveLateRequest = resolve; });
      }
      return new Promise((_resolve, reject) => {
        rejectAbortRequest = reject;
        signal.addEventListener('abort', () => reject(new Error('aborted by close')), { once: true });
      });
    },
    logger: { warn: (...args) => warnings.push(args) }
  });
  const waiter = probe.waitForRecovery();
  waiter.catch(() => {});
  assert.equal(await probe.checkNow(), false);

  const lateCheck = probe.checkNow();
  const abortCheck = probe.checkNow();
  await requestsStarted;
  probe.close();
  const allAbortedOnClose = activeSignals.every((signal) => signal.aborted);
  if (!allAbortedOnClose) rejectAbortRequest(new Error('request was not aborted'));
  resolveLateRequest(modelResponse(true));

  assert.equal(allAbortedOnClose, true);
  assert.deepEqual(await Promise.all([lateCheck, abortCheck]), [null, null]);
  assert.deepEqual(warnings, []);
  await assert.rejects(waiter, /closed/);
});
