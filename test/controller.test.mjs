import assert from "node:assert/strict";
import test from "node:test";

import { GoalWatchdogController } from "../src/controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHarness({
  goalStatus = "blocked",
  goalGetResponses = [],
  goalSetResponses = [],
  turnStartResponses = [],
  turnSteerResponses = [],
  compactResponses = [],
  interruptAfterMs = 120_000,
  recoveryGate = null,
  checkBalances = null,
} = {}) {
  const requests = [];
  const timers = [];
  const cancelled = [];
  const logs = [];
  const goals = goalStatus === null
    ? new Map()
    : new Map([["thread-1", { status: goalStatus }]]);

  const controller = new GoalWatchdogController({
    delaysMs: [30_000, 60_000, 120_000],
    interruptAfterMs,
    recoveryGate,
    checkBalances,
    sendRequest: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/goal/get") {
        if (goalGetResponses.length > 0) {
          const response = goalGetResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        return { goal: goals.get(params.threadId) ?? null };
      }
      if (method === "thread/goal/set") {
        if (goalSetResponses.length > 0) {
          const response = goalSetResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        goals.set(params.threadId, { status: params.status });
        return { goal: goals.get(params.threadId) };
      }
      if (method === "turn/interrupt") {
        return { turnId: params.turnId, status: "interrupting" };
      }
      if (method === "turn/start") {
        if (turnStartResponses.length > 0) {
          const response = turnStartResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        return { turn: { id: "turn-recovery", status: "inProgress" } };
      }
      if (method === "turn/steer") {
        if (turnSteerResponses.length > 0) {
          const response = turnSteerResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        return { turnId: params.expectedTurnId };
      }
      if (method === "thread/compact/start") {
        if (compactResponses.length === 0) return {};
        const response = compactResponses.shift();
        if (response instanceof Error) throw response;
        return response;
      }
      throw new Error(`unexpected method: ${method}`);
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
      cancelled.push(timer);
    },
    logger: {
      info: (message) => logs.push({ level: "info", message }),
      warn: (message) => logs.push({ level: "warn", message }),
      error: (message) => logs.push({ level: "error", message }),
    },
  });

  return { controller, requests, timers, cancelled, goals, logs };
}

function terminal503() {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "service unavailable",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        additionalDetails: null,
      },
    },
  };
}

function retrying503() {
  const notification = terminal503();
  notification.params.willRetry = true;
  return notification;
}

function terminal429(message = "429 Too Many Requests") {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message,
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        additionalDetails: null,
      },
    },
  };
}

function serverOverloaded() {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "model is temporarily overloaded",
        codexErrorInfo: "serverOverloaded",
        additionalDetails: null,
      },
    },
  };
}

function failedTurn(threadId = "thread-1", turnId = "turn-1") {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "failed",
        error: { message: "service unavailable" },
      },
    },
  };
}

function threadStarted(id, { parentThreadId = null, canAcceptDirectInput = true } = {}) {
  return {
    method: "thread/started",
    params: { thread: { id, parentThreadId, canAcceptDirectInput } },
  };
}

function immediateRecoveryGate(calls) {
  return {
    beginRecoveryCheck(context) {
      calls.push(context);
    },
    async waitForRecovery() {
      return "confirmed-healthy";
    },
  };
}

function blockedGoal(status = "blocked") {
  return {
    method: "thread/goal/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      goal: { threadId: "thread-1", status },
    },
  };
}

function contextWindowExceeded() {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-context",
      willRetry: false,
      error: {
        message: "Codex ran out of room in the model's context window.",
        codexErrorInfo: "contextWindowExceeded",
        additionalDetails: null,
      },
    },
  };
}

function completedItem(turnId = "turn-1") {
  return {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId,
      item: { id: "item-1", type: "commandExecution" },
      completedAtMs: Date.now(),
    },
  };
}

test("correlates terminal error and blocked goal in either event order", () => {
  for (const events of [
    [terminal503(), blockedGoal()],
    [blockedGoal(), terminal503()],
  ]) {
    const { controller, timers } = createHarness();
    for (const event of events) controller.handleNotification(event);

    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 30_000);
  }
});

test("checks the current goal before resuming", async () => {
  const { controller, timers, requests, goals } = createHarness();
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    {
      method: "thread/goal/set",
      params: { threadId: "thread-1", status: "active" },
    },
  ]);
  assert.equal(goals.get("thread-1").status, "active");
});

test("429 with insufficient balances stops before model probing or Codex RPC", async () => {
  const gateCalls = [];
  const balanceCalls = [];
  const { controller, timers, requests } = createHarness({
    recoveryGate: immediateRecoveryGate(gateCalls),
    checkBalances: async (context) => {
      balanceCalls.push(context);
      return "insufficient";
    },
  });
  controller.handleNotification(terminal429("429 insufficient_quota: quota exhausted"));
  controller.handleNotification(blockedGoal());

  await timers[0].callback();

  assert.equal(balanceCalls.length, 1);
  assert.equal(balanceCalls[0].error.message, "429 insufficient_quota: quota exhausted");
  assert.equal(balanceCalls[0].signal instanceof AbortSignal, true);
  assert.deepEqual(gateCalls, []);
  assert.deepEqual(requests, []);
});

test("429 with available or unknown balances enters the model gate before recovery", async () => {
  for (const balanceStatus of ["available", "unknown"]) {
    const gateCalls = [];
    const { controller, timers, requests } = createHarness({
      recoveryGate: immediateRecoveryGate(gateCalls),
      checkBalances: async () => balanceStatus,
    });
    controller.handleNotification(terminal429());
    controller.handleNotification(blockedGoal());

    await timers[0].callback();

    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0].balanceStatus, balanceStatus);
    assert.equal(gateCalls[0].error.message, "429 Too Many Requests");
    assert.deepEqual(requests.map(({ method }) => method), [
      "thread/goal/get",
      "thread/goal/set",
    ]);
  }
});

test("non-429 transient and model-capacity errors skip balances and enter the model gate", async () => {
  for (const notification of [terminal503(), serverOverloaded()]) {
    const balanceCalls = [];
    const gateCalls = [];
    const { controller, timers } = createHarness({
      recoveryGate: immediateRecoveryGate(gateCalls),
      checkBalances: async (context) => {
        balanceCalls.push(context);
        return "available";
      },
    });
    controller.handleNotification(notification);
    controller.handleNotification(blockedGoal());

    await timers[0].callback();

    assert.deepEqual(balanceCalls, []);
    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0].balanceStatus, null);
  }
});

test("manual pause during model probing prevents recovery RPC", async () => {
  const recovery = deferred();
  const gateCalls = [];
  const { controller, timers, requests } = createHarness({
    recoveryGate: {
      beginRecoveryCheck(context) {
        gateCalls.push(context);
      },
      waitForRecovery() {
        return recovery.promise;
      },
    },
    checkBalances: async () => "available",
  });
  controller.handleNotification(terminal429());
  controller.handleNotification(blockedGoal());

  const attempt = timers[0].callback();
  await Promise.resolve();
  controller.handleNotification(blockedGoal("paused"));
  recovery.resolve("confirmed-healthy");
  await attempt;

  assert.equal(gateCalls.length, 1);
  assert.deepEqual(requests, []);
});

test("does not continue a failed thread when the final goal lookup is paused", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: "paused",
    recoveryGate: immediateRecoveryGate([]),
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
});

test("does not interrupt a retrying turn when the final goal lookup is paused", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: "paused",
    interruptAfterMs: 5,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(retrying503());

  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
});

test("retrying 429 with insufficient balances performs no Codex RPC", async () => {
  const gateCalls = [];
  const notification = terminal429("429 insufficient_quota: quota exhausted");
  notification.params.willRetry = true;
  const { controller, timers, requests } = createHarness({
    goalStatus: "active",
    recoveryGate: immediateRecoveryGate(gateCalls),
    checkBalances: async () => "insufficient",
    interruptAfterMs: 5,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(notification);

  await timers[0].callback();

  assert.deepEqual(requests, []);
  assert.deepEqual(gateCalls, []);
});

test("starts retrying 429 balance checks before turn progress can cancel recovery", async () => {
  const balance = deferred();
  let balanceSignal;
  let balanceCalls = 0;
  const notification = terminal429();
  notification.params.willRetry = true;
  const { controller, requests } = createHarness({
    goalStatus: "active",
    recoveryGate: immediateRecoveryGate([]),
    checkBalances: async ({ signal }) => {
      balanceCalls += 1;
      balanceSignal = signal;
      return balance.promise;
    },
    interruptAfterMs: 5,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });

  controller.handleNotification(notification);

  assert.equal(balanceCalls, 1);
  controller.handleNotification(completedItem());
  assert.equal(balanceSignal.aborted, true);
  balance.resolve("available");
  await Promise.resolve();
  assert.deepEqual(requests, []);
});

test("continues a failed ordinary thread after plugin-confirmed recovery", async () => {
  const gateCalls = [];
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: immediateRecoveryGate(gateCalls),
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  await timers[0].callback();

  assert.equal(gateCalls.length, 1);
  assert.equal(requests.at(-1).method, "turn/start");
  assert.equal(requests.at(-1).params.threadId, "thread-1");
  assert.match(requests.at(-1).params.input[0].text, /继续完成/);
});

test("routes failed sub-agent recovery to its active direct-input parent", async () => {
  const gateCalls = [];
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: immediateRecoveryGate(gateCalls),
  });
  controller.handleNotification(threadStarted("thread-parent"));
  controller.handleNotification(threadStarted("thread-1", {
    parentThreadId: "thread-parent",
    canAcceptDirectInput: false,
  }));
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-parent", turn: { id: "turn-parent" } },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  await timers[0].callback();

  assert.equal(requests.at(-1).method, "turn/steer");
  assert.equal(requests.at(-1).params.threadId, "thread-parent");
  assert.equal(requests.at(-1).params.expectedTurnId, "turn-parent");
  assert.match(requests.at(-1).params.input[0].text, /子代理线程 thread-1/);
});

test("routes failed sub-agent recovery to its idle direct-input parent", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: immediateRecoveryGate([]),
  });
  controller.handleNotification(threadStarted("thread-parent"));
  controller.handleNotification(threadStarted("thread-1", {
    parentThreadId: "thread-parent",
    canAcceptDirectInput: false,
  }));
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  await timers[0].callback();

  assert.equal(requests.at(-1).method, "turn/start");
  assert.equal(requests.at(-1).params.threadId, "thread-parent");
});

test("controller close cancels the active plugin recovery cycle", async () => {
  const recovery = deferred();
  let cancellations = 0;
  const { controller, timers, requests } = createHarness({
    recoveryGate: {
      beginRecoveryCheck() {},
      waitForRecovery: () => recovery.promise,
      cancelRecoveryCheck() {
        cancellations += 1;
        recovery.reject(new Error("cancelled"));
      },
    },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());
  const attempt = timers[0].callback();
  await Promise.resolve();

  controller.close();
  await attempt;

  assert.equal(cancellations, 1);
  assert.deepEqual(requests, []);
});

test("a newer thread recovery supersedes the old gate owner", async () => {
  const cycles = [];
  let current;
  const recoveryGate = {
    beginRecoveryCheck(context) {
      current = deferred();
      cycles.push({ context, deferred: current });
    },
    waitForRecovery() {
      return current.promise;
    },
    cancelRecoveryCheck() {
      current?.reject(new Error("cancelled"));
    },
  };
  const { controller, timers, requests, goals } = createHarness({ recoveryGate });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());
  const firstRecovery = timers[0].callback();
  await Promise.resolve();

  goals.set("thread-2", { status: "blocked" });
  const secondError = terminal503();
  secondError.params.threadId = "thread-2";
  secondError.params.turnId = "turn-2";
  const secondBlocked = blockedGoal();
  secondBlocked.params.threadId = "thread-2";
  secondBlocked.params.turnId = "turn-2";
  controller.handleNotification(secondError);
  controller.handleNotification(secondBlocked);
  const secondRecovery = timers[1].callback();
  await Promise.resolve();

  cycles[1].deferred.resolve("confirmed-healthy");
  await Promise.all([firstRecovery, secondRecovery]);

  assert.equal(cycles.length, 2);
  assert.deepEqual(
    requests.filter(({ method }) => method === "thread/goal/set"),
    [{ method: "thread/goal/set", params: { threadId: "thread-2", status: "active" } }],
  );
});

test("a newer 429 recovery cancels an older in-flight balance query", async () => {
  const oldBalance = deferred();
  const newBalance = deferred();
  const balanceSignals = new Map();
  const gateEvents = [];
  let currentRecovery;
  const recoveryGate = {
    beginRecoveryCheck({ error }) {
      currentRecovery = deferred();
      gateEvents.push(`begin:${error.message}`);
    },
    waitForRecovery() {
      return currentRecovery.promise;
    },
    cancelRecoveryCheck() {
      gateEvents.push("cancel");
      currentRecovery?.reject(new Error("cancelled"));
    },
  };
  const { controller, timers, goals } = createHarness({
    recoveryGate,
    checkBalances: ({ error, signal }) => {
      balanceSignals.set(error.message, signal);
      return error.message === "old" ? oldBalance.promise : newBalance.promise;
    },
  });
  controller.handleNotification(terminal429("old"));
  controller.handleNotification(blockedGoal());
  const oldAttempt = timers[0].callback();
  await Promise.resolve();

  goals.set("thread-2", { status: "blocked" });
  const newError = terminal429("new");
  newError.params.threadId = "thread-2";
  newError.params.turnId = "turn-2";
  const newBlocked = blockedGoal();
  newBlocked.params.threadId = "thread-2";
  newBlocked.params.turnId = "turn-2";
  controller.handleNotification(newError);
  controller.handleNotification(newBlocked);
  const newAttempt = timers[1].callback();
  await Promise.resolve();

  assert.equal(balanceSignals.get("old").aborted, true);
  newBalance.resolve("available");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(gateEvents, ["cancel", "begin:new"]);

  oldBalance.resolve("available");
  await Promise.resolve();
  assert.deepEqual(gateEvents, ["cancel", "begin:new"]);

  currentRecovery.resolve("confirmed-healthy");
  await Promise.all([oldAttempt, newAttempt]);
});

test("stops ordinary goal recovery after a permanent goal lookup failure", async () => {
  const error = new Error("401 unauthorized");
  error.code = 401;
  const { controller, timers, requests, logs } = createHarness({
    goalGetResponses: [error],
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
  assert.equal(timers.length, 1);
  assert.equal(
    logs.some(({ message }) => message.includes("authentication-failed")),
    true,
  );
});

test("stops ordinary goal recovery after a permanent goal update failure", async () => {
  const error = new Error("403 forbidden");
  error.code = 403;
  const { controller, timers, requests, logs } = createHarness({
    goalSetResponses: [error],
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  await timers[0].callback();

  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "thread/goal/set",
  ]);
  assert.equal(timers.length, 1);
  assert.equal(
    logs.some(({ message }) => message.includes("authentication-failed")),
    true,
  );
});

test("backs off ordinary goal recovery after a transient RPC failure", async () => {
  const error = new Error("503 Service Unavailable");
  error.code = 503;
  const { controller, timers, goals } = createHarness({
    goalGetResponses: [error],
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  await timers[0].callback();
  assert.equal(timers[1].delayMs, 60_000);

  await timers[1].callback();
  assert.equal(goals.get("thread-1").status, "active");
});

test("does not override a manual pause while waiting", async () => {
  const { controller, timers, requests, goals, cancelled } = createHarness();
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());
  goals.set("thread-1", { status: "paused" });
  controller.handleNotification(blockedGoal("paused"));

  assert.equal(cancelled.length, 1);
  assert.equal(timers[0].cancelled, true);
  await timers[0].callback();
  assert.deepEqual(requests, []);
});

test("increases delay after repeated transient failures and resets after success", async () => {
  const { controller, timers, goals } = createHarness();
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());
  await timers[0].callback();

  goals.set("thread-1", { status: "blocked" });
  const retryError = terminal503();
  retryError.params.turnId = "turn-2";
  const retryBlocked = blockedGoal();
  retryBlocked.params.turnId = "turn-2";
  controller.handleNotification(retryError);
  controller.handleNotification(retryBlocked);
  assert.equal(timers[1].delayMs, 60_000);

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-3", status: "completed", error: null },
    },
  });

  goals.set("thread-1", { status: "blocked" });
  const nextError = terminal503();
  nextError.params.turnId = "turn-4";
  const nextBlocked = blockedGoal();
  nextBlocked.params.turnId = "turn-4";
  controller.handleNotification(nextError);
  controller.handleNotification(nextBlocked);
  assert.equal(timers[2].delayMs, 30_000);
});

test("interrupts a long-running retrying turn once, then resumes the goal", async () => {
  const { controller, timers, requests, goals } = createHarness({
    goalStatus: "active",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  controller.handleNotification(retrying503());

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 5_000);

  await timers[0].callback();
  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    {
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    },
  ]);

  controller.handleNotification(retrying503());
  assert.equal(timers.length, 1);

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });

  assert.equal(timers.length, 2);
  assert.equal(timers[1].delayMs, 30_000);
  await timers[1].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    {
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    },
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    {
      method: "thread/goal/set",
      params: { threadId: "thread-1", status: "active" },
    },
  ]);
  assert.equal(goals.get("thread-1").status, "active");
});

test("cancels a pending interrupt when the same turn makes progress", async () => {
  const { controller, timers, requests, cancelled } = createHarness({
    goalStatus: "active",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  controller.handleNotification(retrying503());
  controller.handleNotification(completedItem());

  assert.equal(cancelled.length, 1);
  assert.equal(timers[0].cancelled, true);
  await timers[0].callback();
  assert.deepEqual(requests, []);
});

test("cancels an interrupt when the same turn makes progress during goal lookup", async () => {
  const goalGet = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: "active",
    goalGetResponses: [goalGet.promise],
    interruptAfterMs: 5_000,
  });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  controller.handleNotification(retrying503());

  const interruptAttempt = timers[0].callback();
  await Promise.resolve();
  controller.handleNotification(completedItem());
  goalGet.resolve({ goal: { threadId: "thread-1", status: "active" } });
  await interruptAttempt;

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
});

test("does not let a cancelled interrupt lookup clear a newer interrupt", async () => {
  const oldGoalGet = deferred();
  const { controller, timers } = createHarness({
    goalStatus: "active",
    goalGetResponses: [
      oldGoalGet.promise,
      { goal: { threadId: "thread-1", status: "active" } },
    ],
    interruptAfterMs: 5_000,
  });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  controller.handleNotification(retrying503());
  const oldInterruptAttempt = timers[0].callback();
  await Promise.resolve();

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });
  const newError = retrying503();
  newError.params.turnId = "turn-2";
  controller.handleNotification(newError);
  await timers[1].callback();

  oldGoalGet.reject(new Error("old goal lookup failed"));
  await oldInterruptAttempt;
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "interrupted", error: null },
    },
  });

  assert.equal(timers.length, 3);
  assert.equal(timers[2].delayMs, 30_000);
});

test("keeps an interrupted-turn resume pending when the goal remains active", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: "active",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification(retrying503());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });
  controller.handleNotification(blockedGoal("active"));

  assert.equal(timers[1].cancelled, false);
  await timers[1].callback();
  assert.equal(
    requests.filter((request) => request.method === "thread/goal/set").length,
    1,
  );
});

test("cancels an interrupted-turn resume when a new turn actually starts", async () => {
  const { controller, timers, requests, cancelled } = createHarness({
    goalStatus: "active",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  controller.handleNotification(retrying503());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });

  assert.equal(cancelled.length, 1);
  assert.equal(timers[1].cancelled, true);
  await timers[1].callback();
  assert.equal(
    requests.filter((request) => request.method === "thread/goal/set").length,
    0,
  );
});

test("cancels an interrupted-turn resume when a new turn starts during goal lookup", async () => {
  const resumeGoalGet = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: "active",
    goalGetResponses: [
      { goal: { threadId: "thread-1", status: "active" } },
      resumeGoalGet.promise,
    ],
    interruptAfterMs: 5_000,
  });

  controller.handleNotification(retrying503());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });

  const resumeAttempt = timers[1].callback();
  await Promise.resolve();
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });
  resumeGoalGet.resolve({ goal: { threadId: "thread-1", status: "active" } });
  await resumeAttempt;

  assert.equal(
    requests.filter((request) => request.method === "thread/goal/set").length,
    0,
  );
});

test("cancels an interrupted-turn resume when paused during goal lookup", async () => {
  const resumeGoalGet = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: "active",
    goalGetResponses: [
      { goal: { threadId: "thread-1", status: "active" } },
      resumeGoalGet.promise,
    ],
    interruptAfterMs: 5_000,
  });

  controller.handleNotification(retrying503());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });

  const resumeAttempt = timers[1].callback();
  await Promise.resolve();
  controller.handleNotification(blockedGoal("paused"));
  resumeGoalGet.resolve({ goal: { threadId: "thread-1", status: "active" } });
  await resumeAttempt;

  assert.equal(
    requests.filter((request) => request.method === "thread/goal/set").length,
    0,
  );
});

test("handles turn completion that races the interrupt response", async () => {
  const requests = [];
  const timers = [];
  let controller;
  controller = new GoalWatchdogController({
    delaysMs: [30_000],
    interruptAfterMs: 0,
    sendRequest: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/goal/get") {
        return { goal: { threadId: "thread-1", status: "active" } };
      }
      if (method === "turn/interrupt") {
        controller.handleNotification({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted", error: null },
          },
        });
        return { turnId: params.turnId, status: "interrupting" };
      }
      if (method === "thread/goal/set") {
        return { goal: { threadId: "thread-1", status: "active" } };
      }
      throw new Error(`unexpected method: ${method}`);
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  controller.handleNotification(retrying503());
  await timers[0].callback();

  assert.equal(timers.length, 2);
  assert.equal(timers[1].delayMs, 30_000);
  await timers[1].callback();
  assert.equal(
    requests.filter((request) => request.method === "turn/interrupt").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "thread/goal/set").length,
    1,
  );
});

test("replaces a pending interrupt with terminal blocked-goal recovery", () => {
  const { controller, timers, cancelled } = createHarness({
    goalStatus: "blocked",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification(retrying503());
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  assert.equal(timers.length, 2);
  assert.equal(timers[0].cancelled, true);
  assert.equal(timers[1].delayMs, 30_000);
  assert.equal(cancelled.length, 1);
});

test("does not interrupt a goal that is already blocked", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: "blocked",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification(retrying503());
  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
});

test("uses blocked-goal recovery when the blocked event arrives first", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: "blocked",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification(blockedGoal());
  controller.handleNotification(retrying503());

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 30_000);
  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    {
      method: "thread/goal/set",
      params: { threadId: "thread-1", status: "active" },
    },
  ]);
});

test("ignores a transient error from an older turn after a newer turn starts", () => {
  const { controller, timers } = createHarness({
    goalStatus: "active",
    interruptAfterMs: 5_000,
  });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });
  const staleError = retrying503();
  staleError.params.turnId = "turn-1";
  controller.handleNotification(staleError);

  assert.equal(timers.length, 0);
});

test("ignores context exhaustion from an older turn after a newer turn starts", () => {
  const { controller, timers } = createHarness({ goalStatus: "active" });

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });
  controller.handleNotification(contextWindowExceeded());

  assert.equal(timers.length, 0);
});

test("cancels context recovery when a new turn starts during goal lookup", async () => {
  const lookup = deferred();
  const { controller, timers, requests } = createHarness({
    goalGetResponses: [lookup.promise],
  });
  controller.handleNotification(contextWindowExceeded());
  const recovery = timers[0].callback();
  await Promise.resolve();

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });
  lookup.resolve({ goal: { status: "blocked" } });
  await recovery;

  assert.deepEqual(requests.map(({ method }) => method), ["thread/goal/get"]);
});

test("compacts the original thread and resumes its blocked goal after context exhaustion", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());

  assert.equal(timers[0].delayMs, 0);
  await timers[0].callback();
  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    { method: "thread/compact/start", params: { threadId: "thread-1" } },
  ]);
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-compact" },
  });
  assert.equal(timers.at(-1).delayMs, 0);
  await timers.at(-1).callback();
  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    { method: "thread/compact/start", params: { threadId: "thread-1" } },
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    { method: "thread/goal/set", params: { threadId: "thread-1", status: "active" } },
  ]);
});

test("does not cancel context recovery when the compaction turn completes before resume runs", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-compact" },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "completed", error: null },
    },
  });

  await timers.at(-1).callback();

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});

test("accepts compaction completion after its successful turn completion", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "completed", error: null },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-compact" },
  });

  await timers.at(-1).callback();

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});

test("ignores duplicate context exhaustion while compact is awaiting completion", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();

  controller.handleNotification(contextWindowExceeded());
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-compact" },
  });
  await timers.at(-1).callback();

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});

test("accepts a thread compaction completion notification without a turn id", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1" },
  });
  await timers.at(-1).callback();

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});

test("cancels compact resume when a new turn starts before its lookup", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-compact" },
  });
  const resumeTimer = timers.at(-1);

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });
  await resumeTimer.callback();

  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "thread/compact/start",
  ]);
});

test("cancels compact resume when a new turn starts during its lookup", async () => {
  const lookup = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: "blocked",
    goalGetResponses: [{ goal: { status: "blocked" } }, lookup.promise],
  });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-compact", status: "inProgress" },
    },
  });
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-compact" },
  });
  const resume = timers.at(-1).callback();
  await Promise.resolve();

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });
  lookup.resolve({ goal: { status: "active" } });
  await resume;

  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
  ]);
});

test("stops in-process recovery when the compaction completion event is lost", async () => {
  const { controller, timers, logs } = createHarness({ goalStatus: "blocked" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  await timers.at(-1).callback();

  assert.equal(timers.length, 2);
  assert.equal(
    logs.some(({ message }) => message.includes("compaction completion timed out")),
    true,
  );
});

test("does not compact a manually paused goal", async () => {
  const { controller, timers, requests } = createHarness({ goalStatus: "paused" });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
});

test("does not retry a permanent compact RPC failure", async () => {
  const error = new Error("401 unauthorized");
  error.code = 401;
  const { controller, timers, logs } = createHarness({ compactResponses: [error] });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();

  assert.equal(timers.length, 1);
  assert.equal(logs.some(({ message }) => message.includes("authentication-failed")), true);
});

test("retries a transient compact RPC failure from the 30 second delay", async () => {
  const error = new Error("503 Service Unavailable");
  error.code = 503;
  const { controller, timers } = createHarness({ compactResponses: [error, {}] });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();

  assert.equal(timers[1].delayMs, 30_000);
  await timers[1].callback();
});
