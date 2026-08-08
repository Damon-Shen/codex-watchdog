import assert from "node:assert/strict";
import test from "node:test";

import { GoalWatchdogController } from "../src/controller.mjs";

const DEFAULT_CONTINUE_PROMPT_FOR_TEST =
  "继续完成刚才因上游服务故障而中断的任务。先检查当前状态，不要重复已完成的步骤。";

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
  turnInterruptResponses = [],
  compactResponses = [],
  interruptAfterMs = 120_000,
  recoveryGate = null,
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
        if (turnInterruptResponses.length > 0) {
          const response = turnInterruptResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        return { turnId: params.turnId, status: "interrupting" };
      }
      if (method === "turn/start") {
        if (turnStartResponses.length > 0) {
          const response = turnStartResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        return {
          turn: {
            id: "turn-recovery",
            status: "inProgress",
            items: [],
            error: null,
          },
        };
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

function terminal503(turnId = "turn-1") {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId,
      willRetry: false,
      error: {
        message: "service unavailable",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        additionalDetails: null,
      },
    },
  };
}

function terminal429(turnId = "turn-1") {
  const notification = terminal503();
  notification.params.turnId = turnId;
  notification.params.error.message = "too many requests";
  notification.params.error.codexErrorInfo.httpConnectionFailed.httpStatusCode = 429;
  return notification;
}

function retrying503() {
  const notification = terminal503();
  notification.params.willRetry = true;
  return notification;
}

function failedTurn(turnId = "turn-1") {
  return {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: turnId,
        status: "failed",
        error: { message: "service unavailable" },
      },
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

test("begins recovery check immediately once per transient turn", () => {
  let checks = 0;
  const { controller } = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        checks += 1;
      },
      waitForRecovery: async () => {},
    },
  });

  controller.handleNotification(terminal503());
  assert.equal(checks, 1);

  controller.handleNotification(terminal503());
  assert.equal(checks, 1);

  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });
  const nextError = terminal503();
  nextError.params.turnId = "turn-2";
  controller.handleNotification(nextError);

  assert.equal(checks, 2);
});

test("does not restart recovery check after same-turn progress clears classification", () => {
  let checks = 0;
  const { controller } = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        checks += 1;
      },
    },
  });

  controller.handleNotification(retrying503());
  controller.handleNotification(completedItem());
  assert.equal(
    controller.threads.get("thread-1").transientTurns.has("turn-1"),
    false,
  );

  controller.handleNotification(retrying503());
  assert.equal(checks, 1);
});

test("does not restart recovery check after same-turn recovery clears classification", async () => {
  let checks = 0;
  const { controller, timers } = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        checks += 1;
      },
      waitForRecovery: async () => "confirmed-healthy",
    },
  });

  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());
  await timers[0].callback();
  assert.equal(
    controller.threads.get("thread-1").transientTurns.has("turn-1"),
    false,
  );

  controller.handleNotification(terminal503());
  assert.equal(checks, 1);
});

test("begins recovery check only for accepted context exhaustion", () => {
  let acceptedChecks = 0;
  const accepted = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        acceptedChecks += 1;
      },
    },
  });

  accepted.controller.handleNotification(contextWindowExceeded());
  accepted.controller.handleNotification(contextWindowExceeded());
  assert.equal(acceptedChecks, 1);

  let staleChecks = 0;
  const stale = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        staleChecks += 1;
      },
    },
  });
  stale.controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-new", status: "inProgress" },
    },
  });
  stale.controller.handleNotification(contextWindowExceeded());

  assert.equal(staleChecks, 0);
});

test("shares one recovery check for transient and context errors in the same turn", () => {
  let checks = 0;
  const { controller } = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        checks += 1;
      },
    },
  });

  controller.handleNotification(terminal503("turn-context"));
  controller.handleNotification(contextWindowExceeded());

  assert.equal(checks, 1);
  assert.equal(controller.threads.get("thread-1").pending.kind, "compact");
});

test("ignores delayed errors for completed turns after a newer turn finishes", () => {
  let checks = 0;
  const { controller } = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        checks += 1;
      },
    },
  });

  controller.handleNotification(terminal429("turn-a"));
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-a", status: "interrupted", error: null },
    },
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-b" } },
  });
  controller.handleNotification(terminal429("turn-b"));
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-b", status: "interrupted", error: null },
    },
  });

  controller.handleNotification(terminal429("turn-a"));
  const delayedContext = contextWindowExceeded();
  delayedContext.params.turnId = "turn-a";
  controller.handleNotification(delayedContext);

  const state = controller.threads.get("thread-1");
  assert.equal(checks, 2);
  assert.equal(state.consecutive429Turns, 2);
  assert.equal(state.lastFailureTurnId, "turn-b");
  assert.equal(state.lastFailureWas429, true);
  assert.equal(state.pending, null);
});

test("keeps successful-turn tombstones when normal turn state is cleared", () => {
  let checks = 0;
  const { controller } = createHarness({
    recoveryGate: {
      beginRecoveryCheck: () => {
        checks += 1;
      },
    },
  });

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-finished", status: "completed", error: null },
    },
  });
  controller.handleNotification(terminal503("turn-finished"));
  const delayedContext = contextWindowExceeded();
  delayedContext.params.turnId = "turn-finished";
  controller.handleNotification(delayedContext);

  const state = controller.threads.get("thread-1");
  assert.equal(checks, 0);
  assert.equal(state.consecutive429Turns, 0);
  assert.equal(state.lastFailureTurnId, null);
  assert.equal(state.lastFailureWas429, false);
  assert.equal(state.pending, null);
});

test("counts duplicate 429 notifications once for a turn", () => {
  const { controller } = createHarness();

  controller.handleNotification(terminal429());
  controller.handleNotification(terminal429());

  const state = controller.threads.get("thread-1");
  assert.equal(state.consecutive429Turns, 1);
  assert.equal(state.lastFailureTurnId, "turn-1");
  assert.equal(state.lastFailureWas429, true);
});

test("increments the 429 streak for distinct turns", () => {
  const { controller } = createHarness();

  controller.handleNotification(terminal429());
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });
  controller.handleNotification(terminal429("turn-2"));

  const state = controller.threads.get("thread-1");
  assert.equal(state.consecutive429Turns, 2);
  assert.equal(state.lastFailureTurnId, "turn-2");
  assert.equal(state.lastFailureWas429, true);
});

test("resets 429 tracking after a successful turn", () => {
  const { controller } = createHarness();
  controller.handleNotification(terminal429());

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  });

  const state = controller.threads.get("thread-1");
  assert.equal(state.consecutive429Turns, 0);
  assert.equal(state.lastFailureTurnId, null);
  assert.equal(state.lastFailureWas429, false);
});

test("resets 429 tracking while successful context recovery remains pending", () => {
  const { controller, timers } = createHarness();
  controller.handleNotification(contextWindowExceeded());
  controller.handleNotification(terminal429("turn-429"));

  const state = controller.threads.get("thread-1");
  const pending = state.pending;
  assert.equal(state.consecutive429Turns, 1);
  assert.equal(pending.kind, "compact");

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-context", status: "completed", error: null },
    },
  });

  assert.equal(state.consecutive429Turns, 0);
  assert.equal(state.lastFailureTurnId, null);
  assert.equal(state.lastFailureWas429, false);
  assert.equal(state.pending, pending);
  assert.equal(pending.cancelled, false);
  assert.equal(timers[0].cancelled, false);
});

test("resets the 429 streak after a non-429 transient failure", () => {
  const { controller } = createHarness();

  controller.handleNotification(terminal429());
  controller.handleNotification({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "inProgress" },
    },
  });
  const nextError = terminal503("turn-2");
  controller.handleNotification(nextError);

  const state = controller.threads.get("thread-1");
  assert.equal(state.consecutive429Turns, 0);
  assert.equal(state.lastFailureTurnId, "turn-2");
  assert.equal(state.lastFailureWas429, false);
});

test("context exhaustion breaks the 429 streak before healthy compaction recovery", async () => {
  const { controller, timers, requests, logs } = createHarness({
    recoveryGate: {
      beginRecoveryCheck() {},
      waitForRecovery: async () => "confirmed-healthy",
    },
  });

  controller.handleNotification(terminal429("turn-1"));
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2" } },
  });
  controller.handleNotification(terminal429("turn-2"));
  const contextError = contextWindowExceeded();
  contextError.params.turnId = "turn-2";
  controller.handleNotification(contextError);

  const state = controller.threads.get("thread-1");
  assert.equal(state.consecutive429Turns, 0);
  assert.equal(state.lastFailureTurnId, "turn-2");
  assert.equal(state.lastFailureWas429, false);
  assert.equal(state.transientTurns.has("turn-2"), false);

  await timers[0].callback();
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-2" },
  });
  await timers.at(-1).callback();

  assert.equal(
    requests.filter(({ method }) => method === "thread/goal/set").length,
    1,
  );
  assert.equal(
    logs.some(({ message }) => message.includes("possible daily limit")),
    false,
  );
});

for (const { name, secondOutcome, expectedStarts } of [
  {
    name: "stops a second-turn 429 when the relay is confirmed healthy",
    secondOutcome: "confirmed-healthy",
    expectedStarts: 1,
  },
  {
    name: "continues a second-turn 429 after observing the relay down",
    secondOutcome: "recovered-after-false",
    expectedStarts: 2,
  },
]) {
  test(name, async () => {
    const outcomes = ["confirmed-healthy", secondOutcome];
    const { controller, timers, requests, logs } = createHarness({
      goalStatus: null,
      recoveryGate: {
        beginRecoveryCheck() {},
        waitForRecovery: async () => outcomes.shift(),
      },
    });

    controller.handleNotification(terminal429("turn-1"));
    controller.handleNotification(failedTurn("turn-1"));
    await timers[0].callback();
    controller.handleNotification({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    });
    controller.handleNotification(terminal429("turn-2"));
    controller.handleNotification(failedTurn("turn-2"));
    await timers[1].callback();

    assert.equal(
      requests.filter(({ method }) => method === "turn/start").length,
      expectedStarts,
    );
    assert.equal(
      logs.some(({ message }) => message.includes("possible daily limit")),
      secondOutcome === "confirmed-healthy",
    );
  });
}

for (const { name, secondOutcome, expectedGoalSets } of [
  {
    name: "stops a second goal-mode 429 when the relay is confirmed healthy",
    secondOutcome: "confirmed-healthy",
    expectedGoalSets: 1,
  },
  {
    name: "resumes a second goal-mode 429 after observing the relay down",
    secondOutcome: "recovered-after-false",
    expectedGoalSets: 2,
  },
]) {
  test(name, async () => {
    const cycleOutcomes = ["confirmed-healthy", secondOutcome];
    let cycleOutcome = null;
    const { controller, timers, requests, goals, logs } = createHarness({
      recoveryGate: {
        beginRecoveryCheck() {
          cycleOutcome = cycleOutcomes.shift();
        },
        waitForRecovery: async () => cycleOutcome,
      },
    });

    controller.handleNotification(terminal429("turn-1"));
    controller.handleNotification(blockedGoal());
    await timers[0].callback();

    goals.set("thread-1", { status: "blocked" });
    controller.handleNotification({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    });
    controller.handleNotification(terminal429("turn-2"));
    const secondBlocked = blockedGoal();
    secondBlocked.params.turnId = "turn-2";
    controller.handleNotification(secondBlocked);
    await timers[1].callback();

    assert.equal(
      requests.filter(({ method }) => method === "thread/goal/set").length,
      expectedGoalSets,
    );
    assert.equal(
      logs.some(({ message }) => message.includes("possible daily limit")),
      secondOutcome === "confirmed-healthy",
    );
  });
}

test("does not suppress consecutive 429 recovery without a gate outcome", async () => {
  const { controller, timers, requests, logs } = createHarness();

  controller.handleNotification(terminal429("turn-1"));
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2" } },
  });
  controller.handleNotification(terminal429("turn-2"));
  const secondBlocked = blockedGoal();
  secondBlocked.params.turnId = "turn-2";
  controller.handleNotification(secondBlocked);
  await timers[0].callback();

  assert.equal(
    requests.filter(({ method }) => method === "thread/goal/set").length,
    1,
  );
  assert.equal(
    logs.some(({ message }) => message.includes("possible daily limit")),
    false,
  );
});

test("keeps the original 429 classification until a retrying goal action completes", async () => {
  const error = new Error("503 Service Unavailable");
  error.code = 503;
  let checks = 0;
  let waits = 0;
  const { controller, timers, requests, logs } = createHarness({
    goalSetResponses: [error],
    recoveryGate: {
      beginRecoveryCheck() {
        checks += 1;
      },
      waitForRecovery: async () => {
        waits += 1;
        return "confirmed-healthy";
      },
    },
  });

  controller.handleNotification(terminal429());
  controller.handleNotification(blockedGoal());

  await timers[0].callback();
  assert.equal(
    controller.threads.get("thread-1").transientTurns.get("turn-1").statusCode,
    429,
  );

  await timers[1].callback();
  assert.equal(
    requests.filter(({ method }) => method === "thread/goal/set").length,
    2,
  );
  assert.equal(
    controller.threads.get("thread-1").transientTurns.has("turn-1"),
    false,
  );
  assert.equal(checks, 1);
  assert.equal(waits, 2);
  assert.equal(
    logs.some(({ message }) => message.includes("possible daily limit")),
    false,
  );
});

test("keeps the original 429 classification after interrupting a retrying turn", async () => {
  const { controller, timers, requests, logs } = createHarness({
    goalStatus: null,
    interruptAfterMs: 10,
    recoveryGate: {
      beginRecoveryCheck() {},
      waitForRecovery: async () => "confirmed-healthy",
    },
  });

  controller.handleNotification(terminal429("turn-1"));
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2" } },
  });
  const retrying429 = terminal429("turn-2");
  retrying429.params.willRetry = true;
  controller.handleNotification(retrying429);

  await timers[0].callback();
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "interrupted", error: null },
    },
  });
  assert.equal(
    controller.threads.get("thread-1").transientTurns.get("turn-2").statusCode,
    429,
  );

  await timers[1].callback();
  assert.equal(
    requests.some(({ method }) => method === "turn/start"),
    false,
  );
  assert.equal(
    logs.some(({ message }) => message.includes("possible daily limit")),
    true,
  );
});

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

test("waits for model recovery before resuming a goal", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map(({ method }) => method), ["thread/goal/get"]);

  gate.resolve();
  await recovery;
  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});

test("continues a failed ordinary thread after model recovery", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
  });

  controller.handleNotification(terminal503());
  assert.equal(timers.length, 0);

  controller.handleNotification(failedTurn());
  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some(({ method }) => method === "turn/start"), false);

  gate.resolve();
  await recovery;
  assert.deepEqual(requests.at(-1), {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{
        type: "text",
        text: DEFAULT_CONTINUE_PROMPT_FOR_TEST,
      }],
    },
  });
});

test("cancels ordinary continuation when a user starts a new turn", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());
  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-manual" } },
  });
  gate.resolve();
  await recovery;

  assert.equal(requests.some(({ method }) => method === "turn/start"), false);
});

test("does not continue an ordinary thread without a gate", () => {
  const { controller, timers } = createHarness({ goalStatus: null });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  assert.equal(timers.length, 0);
});

test("does not continue when goal lookup omits the goal field", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    goalGetResponses: [{}],
    recoveryGate: { waitForRecovery: async () => {} },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  await timers[0].callback();

  assert.deepEqual(requests, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
  ]);
});

test("uses neutral recovery logs for a failed ordinary thread", async () => {
  const gate = deferred();
  const { controller, timers, logs } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await recovery;

  assert.equal(
    logs.some(
      ({ message }) =>
        message === "Thread thread-1/turn-1 recovery scheduled in 30000ms",
    ),
    true,
  );
  assert.equal(
    logs.some(
      ({ message }) => message === "Thread thread-1 continued automatically",
    ),
    true,
  );
  assert.deepEqual(
    logs.filter(({ message }) => message.startsWith("Goal ")),
    [],
  );
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

test("interrupts and continues a retrying ordinary thread", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
    interruptAfterMs: 10,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
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
  const recovery = timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await recovery;

  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "turn/interrupt",
    "thread/goal/get",
    "thread/goal/get",
    "turn/start",
  ]);
});

test("continues after a dispatched interrupt response is lost", async () => {
  const gate = deferred();
  const interruptResponse = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
    turnInterruptResponses: [interruptResponse.promise],
    interruptAfterMs: 10,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(retrying503());

  const interruptAttempt = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).method, "turn/interrupt");

  const error = new Error("503 Service Unavailable");
  error.code = 503;
  interruptResponse.reject(error);
  await interruptAttempt;

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });

  assert.equal(timers.length, 2);
  assert.equal(
    requests.filter(({ method }) => method === "turn/interrupt").length,
    1,
  );
  const recovery = timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await recovery;

  assert.equal(
    requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
});

test("does not continue after a definitive interrupt rejection", async () => {
  const interruptResponse = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: async () => {} },
    turnInterruptResponses: [interruptResponse.promise],
    interruptAfterMs: 10,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(retrying503());

  const interruptAttempt = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  const error = new Error("400 invalid request");
  error.code = 400;
  interruptResponse.reject(error);
  await interruptAttempt;

  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });

  assert.equal(timers.length, 1);
  assert.equal(
    requests.some(({ method }) => method === "turn/start"),
    false,
  );
});

test("continues a retrying ordinary thread that fails before its interrupt", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
    interruptAfterMs: 10,
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(retrying503());
  const interruptTimer = timers[0];

  controller.handleNotification(failedTurn("turn-1"));

  assert.equal(interruptTimer.cancelled, true);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delayMs, 30_000);
  await interruptTimer.callback();
  assert.equal(
    requests.some(({ method }) => method === "turn/interrupt"),
    false,
  );

  const recovery = timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await recovery;

  assert.equal(requests.at(-1).method, "turn/start");
});

test("does not retry stale ordinary recovery after a newer turn completes", async () => {
  const turnStart = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: async () => {} },
    turnStartResponses: [turnStart.promise],
  });
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn("turn-1"));

  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).method, "turn/start");

  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-2" } },
  });
  controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed", error: null },
    },
  });
  const error = new Error("503 Service Unavailable");
  error.code = 503;
  turnStart.reject(error);
  await recovery;

  assert.equal(
    requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.equal(timers.length, 1);
});

test("does not retry an uncertain ordinary turn start", async () => {
  const turnStart = deferred();
  const { controller, timers, requests, logs } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: async () => {} },
    turnStartResponses: [turnStart.promise],
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(failedTurn());

  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).method, "turn/start");

  const error = new Error("503 Service Unavailable");
  error.code = 503;
  turnStart.reject(error);
  await recovery;

  assert.equal(
    requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.equal(timers.length, 1);
  assert.equal(controller.threads.has("thread-1"), false);
  assert.equal(
    logs.some(
      ({ message }) =>
        message ===
        "Thread thread-1/turn-1 recovery stopped: turn/start delivery is uncertain",
    ),
    true,
  );
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

test("does not interrupt when goal lookup omits the goal field", async () => {
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    goalGetResponses: [{}],
    recoveryGate: { waitForRecovery: async () => {} },
    interruptAfterMs: 5_000,
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

test("continues an ordinary thread after context compaction", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-context" },
  });
  const recovery = timers.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  await recovery;

  assert.equal(requests.at(-1).method, "turn/start");
  assert.equal(requests.at(-1).params.threadId, "thread-1");
  assert.equal(
    requests.at(-1).params.input[0].text,
    DEFAULT_CONTINUE_PROMPT_FOR_TEST,
  );
});

test("does not retry an uncertain ordinary turn start after compaction", async () => {
  const gate = deferred();
  const turnStart = deferred();
  const { controller, timers, requests, logs } = createHarness({
    goalStatus: null,
    recoveryGate: { waitForRecovery: () => gate.promise },
    turnStartResponses: [turnStart.promise],
  });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-context" },
  });

  const recovery = timers.at(-1).callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    requests.some(({ method }) => method === "turn/start"),
    false,
  );
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).method, "turn/start");
  const timerCountBeforeRejection = timers.length;

  const error = new Error("503 Service Unavailable");
  error.code = 503;
  turnStart.reject(error);
  await recovery;

  assert.equal(
    requests.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.equal(timers.length, timerCountBeforeRejection);
  assert.equal(controller.threads.has("thread-1"), false);
  assert.equal(
    logs.some(
      ({ message }) =>
        message ===
        "Thread thread-1/turn-context recovery after compaction stopped: turn/start delivery is uncertain",
    ),
    true,
  );
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

test("cancels a gated goal resume when a new turn starts", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());
  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-manual" } },
  });
  gate.resolve();
  await recovery;
  assert.equal(requests.some(({ method }) => method === "thread/goal/set"), false);
});

test("gates compacted goal recovery", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-context" },
  });
  const recovery = timers[2].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.some(({ method }) => method === "thread/goal/set"), false);
  gate.resolve();
  await recovery;
  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});

test("does not retry stale compact recovery after a new turn starts during goal update", async () => {
  const goalSet = deferred();
  const { controller, timers, requests, logs } = createHarness({
    goalSetResponses: [goalSet.promise],
  });
  controller.handleNotification(contextWindowExceeded());
  await timers[0].callback();
  controller.handleNotification({
    method: "thread/compacted",
    params: { threadId: "thread-1", turnId: "turn-context" },
  });

  const recovery = timers[2].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).method, "thread/goal/set");
  controller.handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-manual" } },
  });
  const error = new Error("503 Service Unavailable");
  error.code = 503;
  goalSet.reject(error);
  await recovery;

  assert.equal(timers.length, 3);
  assert.equal(
    logs.some(({ message }) =>
      message.includes("Thread thread-1 recovery after compaction failed")
    ),
    false,
  );

  const nextError = terminal503();
  nextError.params.turnId = "turn-manual";
  const nextBlocked = blockedGoal();
  nextBlocked.params.turnId = "turn-manual";
  controller.handleNotification(nextError);
  controller.handleNotification(nextBlocked);
  assert.equal(timers.length, 4);
  assert.equal(timers[3].delayMs, 30_000);
});

test("uses refreshed goal eligibility after model recovery", async () => {
  const gate = deferred();
  const { controller, timers, requests } = createHarness({
    goalGetResponses: [
      { goal: { threadId: "thread-1", status: "blocked" } },
      { goal: { threadId: "thread-1", status: "paused" } },
    ],
    recoveryGate: { waitForRecovery: () => gate.promise },
  });
  controller.handleNotification(terminal503());
  controller.handleNotification(blockedGoal());

  const recovery = timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map(({ method }) => method), ["thread/goal/get"]);
  gate.resolve();
  await recovery;

  assert.deepEqual(requests.map(({ method }) => method), [
    "thread/goal/get",
    "thread/goal/get",
  ]);
});
