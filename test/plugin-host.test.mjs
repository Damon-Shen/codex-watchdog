import assert from "node:assert/strict";
import test from "node:test";

import { createPluginHost } from "../src/plugin-host.mjs";

const config = {
  requestTimeoutMs: 50,
  apiKeys: [{ id: "primary", value: "secret-key" }],
};
const quietLogger = { info() {}, warn() {}, error() {} };

test("provides response metadata and body readers through the host HTTP API", async () => {
  let received;
  const host = createPluginHost({
    config,
    fetchImpl: async (url, init) => {
      received = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await host.http.request({
    url: "https://relay.example/status",
    headers: { authorization: "Bearer secret-key" },
  });

  assert.equal(received.url, "https://relay.example/status");
  assert.equal(received.init.method, "GET");
  assert.equal(received.init.signal instanceof AbortSignal, true);
  assert.equal(response.status, 503);
  assert.equal(response.ok, false);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
  host.close();
});

test("combines caller cancellation with the request timeout", async () => {
  const caller = new AbortController();
  let requestSignal;
  const host = createPluginHost({
    config,
    logger: quietLogger,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  const request = host.http.request({
    url: "https://relay.example/status",
    signal: caller.signal,
  });
  caller.abort(new Error("caller stopped"));

  await assert.rejects(request, /caller stopped/);
  assert.equal(requestSignal.aborted, true);
  host.close();
});

test("aborts active requests when the plugin host closes", async () => {
  let requestSignal;
  const host = createPluginHost({
    config,
    logger: quietLogger,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  const request = host.http.request({ url: "https://relay.example/status" });
  host.close();

  await assert.rejects(request, /closed/i);
  assert.equal(requestSignal.aborted, true);
});

test("aborts requests after the configured timeout", async () => {
  let requestSignal;
  const host = createPluginHost({
    config: { ...config, requestTimeoutMs: 5 },
    logger: quietLogger,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  await assert.rejects(
    () => host.http.request({ url: "https://relay.example/status" }),
    /timed out|timeout/i,
  );
  assert.equal(requestSignal.aborted, true);
  host.close();
});

test("redacts configured secrets from wrapped HTTP failures", async () => {
  const warnings = [];
  const host = createPluginHost({
    config,
    fetchImpl: async () => {
      throw new Error("upstream rejected secret-key");
    },
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
  });

  await assert.rejects(
    () => host.http.request({
      url: "https://relay.example/status?token=secret-key",
      headers: { "x-api-key": "secret-key" },
    }),
    (error) => {
      assert.doesNotMatch(error.message, /secret-key/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /secret-key/);
  host.close();
});

test("rejects non-absolute request URLs", async () => {
  const host = createPluginHost({ config, fetchImpl: async () => new Response() });
  await assert.rejects(() => host.http.request({ url: "/status" }), /absolute URL/i);
  host.close();
});

test("exposes bound built-in balance adapters to plugins", async () => {
  const requests = [];
  const host = createPluginHost({
    config: {
      ...config,
      baseUrl: "https://relay.example",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, authorization: init.headers.authorization });
      return new Response(JSON.stringify({ remaining: 3 }), { status: 200 });
    },
    logger: quietLogger,
  });

  assert.deepEqual(await host.balanceAdapters.sub2api(), [
    { accountId: "primary", balance: 3 },
  ]);
  assert.equal(typeof host.balanceAdapters.newapi, "function");
  assert.deepEqual(requests, [{
    url: "https://relay.example/v1/usage",
    authorization: "Bearer secret-key",
  }]);
  host.close();
});
