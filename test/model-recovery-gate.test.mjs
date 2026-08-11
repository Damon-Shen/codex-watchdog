import assert from "node:assert/strict";
import test from "node:test";

import { ModelRecoveryGate } from "../src/model-recovery-gate.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createScheduler() {
  const timers = [];
  return {
    timers,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function fire(timer) {
  timer.callback();
  await flush();
}

function createGate(samples, overrides = {}) {
  const scheduler = createScheduler();
  const calls = [];
  const warnings = [];
  const gate = new ModelRecoveryGate({
    checkModel: async (context) => {
      calls.push(context);
      const sample = samples.shift();
      if (sample instanceof Error) throw sample;
      return typeof sample === "function" ? sample(context) : sample;
    },
    intervalMs: 30_000,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    logger: { warn: (message) => warnings.push(message) },
    ...overrides,
  });
  return { gate, calls, warnings, timers: scheduler.timers };
}

test("confirms an initially healthy model with two interval-separated true samples", async () => {
  const { gate, calls, timers } = createGate([true, true]);
  gate.beginRecoveryCheck({ threadId: "thread-1" });
  const recovery = gate.waitForRecovery();
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 30_000);
  await fire(timers[0]);

  assert.equal(await recovery, "confirmed-healthy");
  assert.equal(calls[0].threadId, "thread-1");
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  gate.close();
});

test("confirms recovery on the first true after observing false", async () => {
  const { gate, timers } = createGate([false, true]);
  gate.beginRecoveryCheck();
  const recovery = gate.waitForRecovery();
  await flush();
  await fire(timers[0]);

  assert.equal(await recovery, "recovered-after-false");
  gate.close();
});

test("unknown breaks consecutive true but preserves an observed false", async () => {
  const first = createGate([true, null, true, true]);
  first.gate.beginRecoveryCheck();
  const healthy = first.gate.waitForRecovery();
  await flush();
  await fire(first.timers[0]);
  await fire(first.timers[1]);
  await fire(first.timers[2]);
  assert.equal(await healthy, "confirmed-healthy");
  first.gate.close();

  const second = createGate([false, undefined, true]);
  second.gate.beginRecoveryCheck();
  const recovered = second.gate.waitForRecovery();
  await flush();
  await fire(second.timers[0]);
  await fire(second.timers[1]);
  assert.equal(await recovered, "recovered-after-false");
  second.gate.close();
});

test("treats check errors as unknown samples and keeps polling", async () => {
  const { gate, warnings, timers } = createGate([new Error("offline"), true, true]);
  gate.beginRecoveryCheck();
  const recovery = gate.waitForRecovery();
  await flush();
  assert.equal(warnings.length, 1);
  await fire(timers[0]);
  await fire(timers[1]);
  assert.equal(await recovery, "confirmed-healthy");
  gate.close();
});

test("does not overlap model checks", async () => {
  const pending = deferred();
  let active = 0;
  let maximum = 0;
  const scheduler = createScheduler();
  const gate = new ModelRecoveryGate({
    intervalMs: 10,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    checkModel: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        return await pending.promise;
      } finally {
        active -= 1;
      }
    },
  });
  gate.beginRecoveryCheck();
  await flush();
  assert.equal(scheduler.timers.length, 0);
  pending.resolve(false);
  await flush();
  assert.equal(maximum, 1);
  assert.equal(scheduler.timers.length, 1);
  gate.close();
});

test("a superseding cycle aborts old work and ignores its late result", async () => {
  const old = deferred();
  const signals = [];
  let count = 0;
  const scheduler = createScheduler();
  const gate = new ModelRecoveryGate({
    intervalMs: 10,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    checkModel: async ({ signal }) => {
      signals.push(signal);
      count += 1;
      return count === 1 ? old.promise : true;
    },
  });
  gate.beginRecoveryCheck({ turnId: "old" });
  await flush();
  gate.beginRecoveryCheck({ turnId: "new" });
  const recovery = gate.waitForRecovery();
  await flush();
  assert.equal(signals[0].aborted, true);
  old.resolve(false);
  await flush();
  await fire(scheduler.timers[0]);
  assert.equal(await recovery, "confirmed-healthy");
  gate.close();
});

test("close cancels timers, aborts requests, and rejects waiters", async () => {
  const pending = deferred();
  let signal;
  const scheduler = createScheduler();
  const gate = new ModelRecoveryGate({
    intervalMs: 10,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    checkModel: ({ signal: requestSignal }) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  gate.beginRecoveryCheck();
  const recovery = gate.waitForRecovery();
  recovery.catch(() => {});
  await flush();
  gate.close();

  assert.equal(signal.aborted, true);
  await assert.rejects(recovery, /closed/i);
  pending.resolve(true);
});

test("cancels one recovery cycle without closing the reusable gate", async () => {
  const pending = deferred();
  let signal;
  const scheduler = createScheduler();
  const gate = new ModelRecoveryGate({
    intervalMs: 10,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    checkModel: ({ signal: requestSignal }) => {
      signal = requestSignal;
      return pending.promise;
    },
  });
  gate.beginRecoveryCheck();
  const cancelled = gate.waitForRecovery();
  cancelled.catch(() => {});
  await flush();

  gate.cancelRecoveryCheck();

  assert.equal(signal.aborted, true);
  await assert.rejects(cancelled, /cancelled/i);
  pending.resolve(true);
  gate.beginRecoveryCheck();
  gate.close();
});

test("validates constructor arguments", () => {
  assert.throws(() => new ModelRecoveryGate({ intervalMs: 1 }), /checkModel/);
  assert.throws(() => new ModelRecoveryGate({ checkModel() {}, intervalMs: 0 }), /intervalMs/);
});
