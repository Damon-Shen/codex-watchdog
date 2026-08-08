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

test('HTTP and fetch failures return null without changing a down outage', async () => {
  const warnings = [];
  let mode = 'http';
  const probe = new ModelRecoveryProbe({
    url: 'http://probe',
    targetModel: 'target',
    fetchImpl: async () => {
      if (mode === 'fetch') throw new Error('offline');
      if (mode === 'down') return { ok: true, json: async () => ({ services: [{ model: 'target', last: { ok: false } }] }) };
      return { ok: false, json: async () => ({}) };
    },
    logger: { warn: (...args) => warnings.push(args) }
  });

  assert.equal(await probe.checkNow(), null);
  mode = 'fetch';
  assert.equal(await probe.checkNow(), null);
  const waiter = probe.waitForRecovery();
  mode = 'down';
  assert.equal(await probe.checkNow(), false);
  mode = 'fetch';
  assert.equal(await probe.checkNow(), null);
  let settled = false;
  waiter.then(() => { settled = true; }, () => {});
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(warnings.length, 3);
  probe.close();
  await assert.rejects(waiter, /closed/);
});
