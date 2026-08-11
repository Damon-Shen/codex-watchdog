import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { loadPlugin } from "../src/plugin-loader.mjs";
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

async function startMockAppServer() {
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
            result: { goal: { threadId: "thread-1", status: "blocked" } },
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

test("passes relay recovery dependencies through the proxy controller", async (t) => {
  const upstream = await startMockAppServer();
  const balanceCalls = [];
  const gateCalls = [];
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [0],
    checkBalances: async (context) => {
      balanceCalls.push(context);
      return "available";
    },
    recoveryGate: immediateRecoveryGate(gateCalls),
    logger: { info() {}, warn() {}, error() {} },
  });
  const tui = new WebSocket(proxy.url);
  t.after(async () => {
    tui.terminate();
    await proxy.close();
    await upstream.close();
  });
  await waitForOpen(tui);
  const initialized = waitForMessage(tui, (message) => message.id === "plugin-init");
  tui.send(JSON.stringify({
    method: "initialize",
    id: "plugin-init",
    params: { clientInfo: { name: "test", title: "Test", version: "1" } },
  }));
  await initialized;

  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "429 Too Many Requests",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
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

  await waitForMessage(
    tui,
    (message) => message.method === "thread/goal/updated" && message.params.goal.status === "active",
  );
  assert.equal(balanceCalls.length, 1);
  assert.equal(gateCalls.length, 1);
});

test("recovers through a loaded local plugin runtime", async (t) => {
  const pluginRoot = await mkdtemp(path.join(os.tmpdir(), "watchdog-proxy-plugin-"));
  const configPath = path.join(pluginRoot, "plugins", "relay.json");
  const pluginLogs = [];
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(path.join(path.dirname(configPath), "relay.mjs"), `
export default ({ config, host }) => {
  let modelChecks = 0;
  return {
    apiVersion: 1,
    checkModel: async () => {
      modelChecks += 1;
      host.logger.info(\`model check \${modelChecks} with \${config.apiKeys[0].value}\`);
      return modelChecks > 1;
    },
    checkBalances: async () => {
      host.logger.info(\`balance check with \${config.apiKeys[0].value}\`);
      return [{ accountId: "primary", balance: 10 }];
    },
  };
};
`);
  await writeFile(configPath, JSON.stringify({
    apiVersion: 1,
    module: "./relay.mjs",
    stack: "custom",
    baseUrl: "https://relay.example",
    apiKeys: [{ id: "primary", value: "secret" }],
    model: "gpt-test",
    probeIntervalMs: 1,
    requestTimeoutMs: 50,
    balancePolicy: { mode: "any", minimum: 1 },
  }));
  const runtime = await loadPlugin("relay", {
    configPath,
    logger: {
      info: (message) => pluginLogs.push(message),
      warn: (message) => pluginLogs.push(message),
      error: (message) => pluginLogs.push(message),
    },
  });
  const upstream = await startMockAppServer();
  const proxy = await createWatchdogProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamUrl: upstream.url,
    delaysMs: [0],
    checkBalances: runtime.checkBalances,
    recoveryGate: runtime.recoveryGate,
    logger: { info() {}, warn() {}, error() {} },
  });
  const tui = new WebSocket(proxy.url);
  t.after(async () => {
    tui.terminate();
    await proxy.close();
    await runtime.close();
    await upstream.close();
    await rm(pluginRoot, { recursive: true, force: true });
  });
  await waitForOpen(tui);
  const initialized = waitForMessage(tui, (message) => message.id === "runtime-init");
  tui.send(JSON.stringify({
    method: "initialize",
    id: "runtime-init",
    params: { clientInfo: { name: "test", title: "Test", version: "1" } },
  }));
  await initialized;

  upstream.send({
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "429 Too Many Requests",
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
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

  await waitForMessage(
    tui,
    (message) => message.method === "thread/goal/updated" && message.params.goal.status === "active",
  );
  assert.deepEqual(
    upstream.received
      .filter((message) => String(message.id ?? "").startsWith("goal-watchdog:"))
      .map((message) => message.method),
    ["thread/goal/get", "thread/goal/set"],
  );
  assert.match(pluginLogs.join("\n"), /model check 1/);
  assert.match(pluginLogs.join("\n"), /model check 2/);
  assert.match(pluginLogs.join("\n"), /\[REDACTED\]/);
  assert.doesNotMatch(pluginLogs.join("\n"), /secret/);
});
