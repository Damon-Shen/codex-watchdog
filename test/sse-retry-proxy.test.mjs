import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  classifyBufferedResponse,
  createSseRetryProxy,
} from "../src/sse-retry-proxy.mjs";

async function startUpstream(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    await handler({ request, response, requests, body });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sse(...events) {
  return `${events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")}data: [DONE]\n\n`;
}

test("forwards a successful Responses SSE request once", async (t) => {
  const upstream = await startUpstream(({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    retryDelaysMs: [0],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.completed/);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers.authorization, "Bearer test");
  assert.deepEqual(JSON.parse(upstream.requests[0].body), { model: "gpt-test", stream: true });
});

test("classifies a top-level SSE error event as recoverable", () => {
  const body = Buffer.from(sse({
    event: "error",
    data: {
      type: "error",
      code: "server_overloaded",
      message: "Selected model is at capacity. Please try a different model.",
    },
  }));
  assert.deepEqual(classifyBufferedResponse({
    status: 200,
    contentType: "text/event-stream",
    body,
  }), {
    retryable: true,
    reason: "SSE error",
  });
});

test("classifies the Codex premature stream disconnect message as recoverable", () => {
  const body = Buffer.from(sse({
    event: "error",
    data: {
      type: "error",
      message: "stream disconnected before completion: stream closed before response.completed",
    },
  }));
  assert.deepEqual(classifyBufferedResponse({
    status: 200,
    contentType: "text/event-stream",
    body,
  }), {
    retryable: true,
    reason: "SSE error",
  });
});

test("classifies the upstream api_error temporarily unavailable message as recoverable", () => {
  const body = Buffer.from(sse({
    event: "error",
    data: {
      type: "error",
      error: {
        message: "Service temporarily unavailable",
        type: "api_error",
      },
      detail: "after 3 attempts",
    },
  }));
  assert.deepEqual(classifyBufferedResponse({
    status: 200,
    contentType: "text/event-stream",
    body,
  }), {
    retryable: true,
    reason: "SSE error",
  });
});

test("retries an SSE stream that closes without a terminal response event", async (t) => {
  const upstream = await startUpstream(({ response, requests }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"not visible\"}\n\n");
      return;
    }
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  const logs = [];
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    retryDelaysMs: [0],
    logger: { info() {}, warn: (message) => logs.push(message), error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", stream: true }),
  });
  const body = await response.text();
  assert.equal(upstream.requests.length, 2);
  assert.equal(body.includes("not visible"), false);
  assert.match(body, /response\.completed/);
  assert.ok(logs.some((message) => message.includes("closed before response.completed")));
});

test("suppresses a capacity-failed SSE attempt and replays the original request", async (t) => {
  const upstream = await startUpstream(({ response, requests }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      response.end(sse(
        {
          event: "response.output_text.delta",
          data: { type: "response.output_text.delta", delta: "not visible" },
        },
        {
          event: "response.failed",
          data: {
            type: "response.failed",
            response: {
              status: "failed",
              error: {
                code: "server_overloaded",
                message: "Selected model is at capacity. Please try a different model.",
              },
            },
          },
        },
      ));
      return;
    }
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  const logs = [];
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    retryDelaysMs: [0],
    logger: { info() {}, warn: (message) => logs.push(message), error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", stream: true }),
  });
  const body = await response.text();
  assert.equal(upstream.requests.length, 2);
  assert.equal(body.includes("not visible"), false);
  assert.match(body, /response\.completed/);
  assert.ok(logs.some((message) => message.includes("SSE response.failed")));
});

test("retries recoverable HTTP failures before forwarding a success", async (t) => {
  const upstream = await startUpstream(({ response, requests }) => {
    if (requests.length === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    retryDelaysMs: [0],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 2);
});

test("retries the exact upstream 503 api_error payload", async (t) => {
  const upstream = await startUpstream(({ response, requests }) => {
    if (requests.length === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(`${JSON.stringify({
        error: { message: "Service temporarily unavailable", type: "api_error" },
      })} (after 3 attempts)`);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    retryDelaysMs: [0],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 2);
});

test("forwards a non-recoverable failed SSE response without replay", async (t) => {
  const upstream = await startUpstream(({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({
      event: "response.failed",
      data: {
        type: "response.failed",
        response: { status: "failed", error: { code: "invalid_request", message: "bad input" } },
      },
    }));
  });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    retryDelaysMs: [0, 0],
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/v1/responses`, { method: "POST", body: "{}" });
  assert.match(await response.text(), /invalid_request/);
  assert.equal(upstream.requests.length, 1);
});

test("exposes a local health endpoint without contacting upstream", async (t) => {
  const upstream = await startUpstream(() => {
    throw new Error("health probe must not reach upstream");
  });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok\n");
  assert.equal(upstream.requests.length, 0);
});

test("holds a Responses request behind a gate before contacting upstream", async (t) => {
  const upstream = await startUpstream(({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    requestGate: async () => gate,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const responsePromise = fetch(`${proxy.url}/v1/responses`, { method: "POST", body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstream.requests.length, 0);

  releaseGate();
  const response = await responsePromise;
  assert.match(await response.text(), /response\.completed/);
  assert.equal(upstream.requests.length, 1);
});

test("exposes model monitor state through the local status endpoint", async (t) => {
  const upstream = await startUpstream(() => {
    throw new Error("status probe must not reach upstream");
  });
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    statusProvider: () => ({ enabled: true, state: "offline", model: "gpt-5.6-sol" }),
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const response = await fetch(`${proxy.url}/statusz`);
  assert.deepEqual(await response.json(), {
    enabled: true,
    state: "offline",
    model: "gpt-5.6-sol",
  });
  assert.equal(upstream.requests.length, 0);
});

test("passes the raw request to an optional observer without changing forwarding", async (t) => {
  const upstream = await startUpstream(({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse({ event: "response.completed", data: { type: "response.completed" } }));
  });
  const observed = [];
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    requestObserver: (request) => observed.push(request),
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  await (await fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread_id: "thread-test", input: [] }),
  })).text();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].requestUrl, "/v1/responses");
  assert.match(observed[0].body.toString(), /thread-test/);
});
