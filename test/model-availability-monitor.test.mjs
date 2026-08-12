import assert from "node:assert/strict";
import test from "node:test";

import { ModelAvailabilityMonitor } from "../src/model-availability-monitor.mjs";

function statusResponse(ok, overrides = {}) {
  return new Response(JSON.stringify({
    generated_at: 123,
    services: [{
      model: "gpt-5.6-sol",
      last: { ok, latency_ms: ok ? 1500 : null, error: ok ? null : "HTTP 503" },
    }],
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("holds waiters while the model is offline and releases them when it recovers", async () => {
  const replies = [statusResponse(false), statusResponse(true)];
  const logs = [];
  const monitor = new ModelAvailabilityMonitor({
    url: "https://status.example/api/status",
    targetModel: "gpt-5.6-sol",
    fetchImpl: async () => replies.shift(),
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });

  assert.equal(await monitor.checkNow(), false);
  assert.equal(monitor.available, false);
  assert.equal(monitor.snapshot().state, "offline");

  let released = false;
  const waiting = monitor.waitUntilAvailable().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);

  assert.equal(await monitor.checkNow(), true);
  await waiting;
  assert.equal(released, true);
  assert.equal(monitor.snapshot().state, "online");
  assert.equal(monitor.snapshot().latencyMs, 1500);
  assert.ok(logs.some((message) => message.includes("offline")));
  assert.ok(logs.some((message) => message.includes("online")));
  monitor.close();
});

test("treats status endpoint failures as unknown and keeps requests paused", async () => {
  const monitor = new ModelAvailabilityMonitor({
    url: "https://status.example/api/status",
    targetModel: "gpt-5.6-sol",
    fetchImpl: async () => { throw new Error("network unavailable"); },
    logger: { info() {}, warn() {} },
  });

  assert.equal(await monitor.checkNow(), null);
  assert.equal(monitor.available, false);
  assert.equal(monitor.snapshot().state, "unknown");
  assert.match(monitor.snapshot().error, /network unavailable/);
  monitor.close();
});

test("rejects paused requests when the monitor closes", async () => {
  const monitor = new ModelAvailabilityMonitor({
    url: "https://status.example/api/status",
    targetModel: "gpt-5.6-sol",
  });
  const waiting = monitor.waitUntilAvailable();
  monitor.close();
  await assert.rejects(waiting, /closed/);
});
