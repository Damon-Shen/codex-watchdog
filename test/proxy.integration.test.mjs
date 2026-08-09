import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { createWatchdogProxy } from "../src/proxy.mjs";

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessage(socket, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for websocket message"));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function waitForCondition(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startMockAppServer({
  goal = { threadId: "thread-1", status: "blocked" },
} = {}) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const received = [];
  let connection;

  wss.on("connection", (socket) => {
    connection = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "mock" } }));
      } else if (message.method === "thread/goal/get") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { goal },
          }),
        );
      } else if (message.method === "thread/goal/set") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { goal: { threadId: "thread-1", status: "active" } },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "thread/goal/updated",
            params: {
              threadId: "thread-1",
              turnId: null,
              goal: { threadId: "thread-1", status: "active" },
            },
          }),
        );
      } else if (message.method === "thread/compact/start") {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        setImmediate(() => socket.send(JSON.stringify({
          method: "thread/compacted",
          params: { threadId: "thread-1", turnId: "turn-compact" },
        })));
      } else if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { turn: { id: "turn-recovery", status: "inProgress" } },
        }));
      } else if (message.method === "turn/steer") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { turnId: message.params.expectedTurnId },
        }));
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    send(message) {
      connection.send(JSON.stringify(message));
    },
    async close() {
      connection?.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

async function startRetryingMockAppServer() {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const received = [];
  let connection;
  let goalStatus = "active";

  wss.on("connection", (socket) => {
    connection = socket;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "mock" } }));
      } else if (message.method === "thread/goal/get") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { goal: { threadId: "thread-1", status: goalStatus } },
          }),
        );
      } else if (message.method === "turn/interrupt") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { turnId: message.params.turnId, status: "interrupting" },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: message.params.turnId, status: "interrupted", error: null },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "thread/goal/updated",
            params: {
              threadId: "thread-1",
              turnId: message.params.turnId,
              goal: { threadId: "thread-1", status: "active" },
            },
          }),
        );
      } else if (message.method === "thread/goal/set") {
        goalStatus = message.params.status;
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { goal: { threadId: "thread-1", status: goalStatus } },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "thread/goal/updated",
            params: {
              threadId: "thread-1",
              turnId: null,
              goal: { threadId: "thread-1", status: goalStatus },
            },
          }),
        );
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    send(message) {
      connection.send(JSON.stringify(message));
    },
    async close() {
      connection?.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

test("transparently forwards TUI traffic and injects an isolated goal resume", async (t) => {
  const upstream = await startMockAppServer();
  const logs = [];
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [5],
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const tui = new WebSocket(proxy.url);

  t.after(async () => {
    tui.close();
    await proxy.close();
    await upstream.close();
  });

  await waitForOpen(tui);
  const initializeResponse = waitForMessage(tui, (message) => message.id === 7);
  tui.send(
    JSON.stringify({
      method: "initialize",
      id: 7,
      params: { clientInfo: { name: "test", title: "Test", version: "1" } },
    }),
  );
  assert.deepEqual(await initializeResponse, { id: 7, result: { userAgent: "mock" } });

  const forwardedError = waitForMessage(tui, (message) => message.method === "error");
  const forwardedBlocked = waitForMessage(
    tui,
    (message) => message.method === "thread/goal/updated" && message.params.turnId === "turn-1",
  );
  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "upstream 503",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        additionalDetails: null,
      },
    },
  });
  upstream.send({
    method: "thread/goal/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      goal: { threadId: "thread-1", status: "blocked" },
    },
  });

  assert.equal((await forwardedError).params.error.message, "upstream 503");
  assert.equal((await forwardedBlocked).params.goal.status, "blocked");

  const resumedNotification = await waitForMessage(
    tui,
    (message) =>
      message.method === "thread/goal/updated" && message.params.goal.status === "active",
  );
  assert.equal(resumedNotification.params.goal.status, "active");

  const internalMethods = upstream.received
    .filter((message) => String(message.id ?? "").startsWith("goal-watchdog:"))
    .map((message) => message.method);
  assert.deepEqual(internalMethods, ["thread/goal/get", "thread/goal/set"]);
  assert.equal(
    upstream.received.find((message) => message.method === "thread/goal/set").params.status,
    "active",
  );
  assert.ok(logs.some((message) => message.includes("resumed automatically")));
});

test("continues an ordinary thread after the recovery gate resolves", async (t) => {
  const upstream = await startMockAppServer({ goal: null });
  const recovery = createDeferred();
  const logs = [];
  let beginCalls = 0;
  let waitCalls = 0;
  let closeCalls = 0;
  const recoveryGate = {
    beginRecoveryCheck() {
      assert.equal(this, recoveryGate);
      beginCalls += 1;
    },
    waitForRecovery() {
      assert.equal(this, recoveryGate);
      waitCalls += 1;
      return recovery.promise;
    },
    close() {
      closeCalls += 1;
    },
  };
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [0],
    recoveryGate,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const tui = new WebSocket(proxy.url);

  t.after(async () => {
    tui.close();
    await proxy.close();
    assert.equal(closeCalls, 0);
    await upstream.close();
  });

  await waitForOpen(tui);
  const initializeResponse = waitForMessage(tui, (message) => message.id === "ordinary-init");
  tui.send(JSON.stringify({
    method: "initialize",
    id: "ordinary-init",
    params: { clientInfo: { name: "test", title: "Test", version: "1" } },
  }));
  await initializeResponse;

  const forwardedError = waitForMessage(tui, (message) => message.method === "error");
  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "upstream 503",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        additionalDetails: null,
      },
    },
  });

  await forwardedError;
  assert.equal(beginCalls, 1);
  assert.equal(waitCalls, 0);
  assert.equal(
    upstream.received.filter(({ method }) => method === "turn/start").length,
    0,
  );

  const forwardedCompletion = waitForMessage(
    tui,
    (message) => message.method === "turn/completed" && message.params.turn.id === "turn-1",
  );
  upstream.send({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "failed",
        error: { message: "upstream 503" },
      },
    },
  });

  await forwardedCompletion;
  await waitForCondition(() => waitCalls === 1);
  assert.equal(
    upstream.received.filter(({ method }) => method === "turn/start").length,
    0,
  );

  recovery.resolve("confirmed-healthy");
  await waitForCondition(() => logs.some((message) => message.includes("continued automatically")));

  const turnStarts = upstream.received.filter(({ method }) => method === "turn/start");
  assert.equal(turnStarts.length, 1);
  assert.deepEqual(turnStarts[0].params, {
    threadId: "thread-1",
    input: [{
      type: "text",
      text: "继续完成刚才因上游服务故障而中断的任务。先检查当前状态，不要重复已完成的步骤。",
    }],
  });
});

test("routes sub-agent recovery through its active parent over the proxy", async (t) => {
  const upstream = await startMockAppServer({ goal: null });
  const logs = [];
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [0],
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const tui = new WebSocket(proxy.url);
  t.after(async () => {
    tui.terminate();
    await proxy.close();
    await upstream.close();
  });
  await waitForOpen(tui);
  const initialized = waitForMessage(tui, (message) => message.id === "sub-agent-init");
  tui.send(JSON.stringify({
    method: "initialize",
    id: "sub-agent-init",
    params: { clientInfo: { name: "test", title: "Test", version: "1" } },
  }));
  await initialized;

  upstream.send({
    method: "thread/started",
    params: {
      thread: {
        id: "thread-parent",
        parentThreadId: null,
        canAcceptDirectInput: true,
      },
    },
  });
  upstream.send({
    method: "thread/started",
    params: {
      thread: {
        id: "thread-1",
        parentThreadId: "thread-parent",
        canAcceptDirectInput: false,
      },
    },
  });
  upstream.send({
    method: "turn/started",
    params: { threadId: "thread-parent", turn: { id: "turn-parent" } },
  });
  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-child",
      willRetry: false,
      error: {
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
        additionalDetails: null,
      },
    },
  });
  upstream.send({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-child",
        status: "failed",
        error: { message: "model at capacity" },
      },
    },
  });

  const steer = await waitForCondition(() => (
    upstream.received.find(({ method }) => method === "turn/steer")
  ));
  assert.deepEqual(steer.params, {
    threadId: "thread-parent",
    expectedTurnId: "turn-parent",
    input: [{
      type: "text",
      text: "子代理线程 thread-1 因上游服务故障中断。请检查该子任务状态，必要时重新派发，并继续完成原任务；不要重复已完成步骤。",
    }],
  });
  assert.equal(
    upstream.received.some(
      ({ method, params }) => method === "turn/start" && params.threadId === "thread-1",
    ),
    false,
  );
  assert.equal(
    logs.some((message) => message.includes("Routing sub-agent recovery")),
    true,
  );
});

test("forwards a retrying-turn interrupt and resumes the goal through app-server", async (t) => {
  const upstream = await startRetryingMockAppServer();
  const logs = [];
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [5],
    interruptAfterMs: 5,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const tui = new WebSocket(proxy.url);

  t.after(async () => {
    tui.close();
    await proxy.close();
    await upstream.close();
  });

  await waitForOpen(tui);
  const initializeResponse = waitForMessage(tui, (message) => message.id === "retry-initialize");
  tui.send(
    JSON.stringify({
      method: "initialize",
      id: "retry-initialize",
      params: { clientInfo: { name: "test", title: "Test", version: "1" } },
    }),
  );
  await initializeResponse;

  const forwardedError = waitForMessage(tui, (message) => message.method === "error");
  const interrupted = waitForMessage(
    tui,
    (message) =>
      message.method === "turn/completed" && message.params.turn.status === "interrupted",
  );
  const resumed = waitForMessage(
    tui,
    (message) =>
      message.method === "thread/goal/updated" &&
      message.params.goal.status === "active" &&
      message.params.turnId === null,
  );
  upstream.send({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: {
        message: "upstream 503",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        additionalDetails: null,
      },
    },
  });

  assert.equal((await forwardedError).params.willRetry, true);
  await interrupted;
  await resumed;

  const internalMethods = upstream.received
    .filter((message) => String(message.id ?? "").startsWith("goal-watchdog:"))
    .map((message) => message.method);
  assert.deepEqual(internalMethods, [
    "thread/goal/get",
    "turn/interrupt",
    "thread/goal/get",
    "thread/goal/set",
  ]);
  assert.ok(logs.some((message) => message.includes("Interrupted transient turn")));
});

test("cancels a retrying-turn interrupt after app-server item progress", async (t) => {
  const upstream = await startRetryingMockAppServer();
  const logs = [];
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [5],
    interruptAfterMs: 20,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });
  const tui = new WebSocket(proxy.url);

  t.after(async () => {
    tui.close();
    await proxy.close();
    await upstream.close();
  });

  await waitForOpen(tui);
  const initializeResponse = waitForMessage(tui, (message) => message.id === "progress-init");
  tui.send(
    JSON.stringify({
      method: "initialize",
      id: "progress-init",
      params: { clientInfo: { name: "test", title: "Test", version: "1" } },
    }),
  );
  await initializeResponse;

  const progressForwarded = waitForMessage(
    tui,
    (message) => message.method === "item/completed" && message.params.turnId === "turn-1",
  );
  upstream.send({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    },
  });
  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: {
        message: "stream disconnected",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: null,
      },
    },
  });
  upstream.send({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-1", type: "commandExecution" },
      completedAtMs: Date.now(),
    },
  });

  await progressForwarded;
  await new Promise((resolve) => setTimeout(resolve, 60));

  const internalMethods = upstream.received
    .filter((message) => String(message.id ?? "").startsWith("goal-watchdog:"))
    .map((message) => message.method);
  assert.equal(internalMethods.includes("turn/interrupt"), false);
  assert.ok(
    logs.some(
      (message) =>
        message.includes("Cancelled pending interrupt") && message.includes("item/completed"),
    ),
  );
});

test("waits for compaction completion before resuming through the proxy", async (t) => {
  const upstream = await startMockAppServer();
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [0],
    logger: { info() {}, warn() {}, error() {} },
  });
  const tui = new WebSocket(proxy.url);
  t.after(async () => {
    tui.terminate();
    await proxy.close();
    await upstream.close();
  });
  await waitForOpen(tui);
  const initialized = waitForMessage(tui, (message) => message.id === "compact-init");
  tui.send(JSON.stringify({
    method: "initialize",
    id: "compact-init",
    params: { clientInfo: { name: "test", title: "Test", version: "1" } },
  }));
  await initialized;

  const compacted = waitForMessage(tui, (message) => message.method === "thread/compacted");
  const resumed = waitForMessage(
    tui,
    (message) => message.method === "thread/goal/updated" && message.params.goal.status === "active",
  );
  upstream.send({
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
  });
  await compacted;
  await resumed;

  const methods = upstream.received
    .filter((message) => String(message.id ?? "").startsWith("goal-watchdog:"))
    .map((message) => message.method);
  assert.deepEqual(methods, [
    "thread/goal/get",
    "thread/compact/start",
    "thread/goal/get",
    "thread/goal/set",
  ]);
});
