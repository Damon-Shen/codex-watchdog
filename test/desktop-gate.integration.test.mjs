import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DesktopThreadPolicy, readThreadIdFromResponsesBody } from "../src/desktop-thread-policy.mjs";
import { ModelAvailabilityMonitor } from "../src/model-availability-monitor.mjs";
import { createSseRetryProxy } from "../src/sse-retry-proxy.mjs";

async function startUpstream() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("only selected desktop conversations wait for model recovery", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "desktop-gate-integration-"));
  const policyPath = path.join(directory, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    default: "bypass",
    threads: { selected: "monitor" },
  }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let modelOnline = false;
  const monitor = new ModelAvailabilityMonitor({
    url: "https://status.example/api/status",
    targetModel: "gpt-5.6-sol",
    fetchImpl: async () => new Response(JSON.stringify({
      services: [{ model: "gpt-5.6-sol", last: { ok: modelOnline } }],
    })),
    logger: { info() {}, warn() {} },
  });
  t.after(() => monitor.close());
  assert.equal(await monitor.checkNow(), false);

  const policy = new DesktopThreadPolicy({ filePath: policyPath, logger: { warn() {} } });
  const upstream = await startUpstream();
  const proxy = await createSseRetryProxy({
    listenPort: 0,
    upstreamOrigin: upstream.origin,
    requestGate: async ({ body, signal }) => {
      const threadId = readThreadIdFromResponsesBody(body);
      if (policy.shouldMonitor(threadId)) await monitor.waitUntilAvailable({ signal });
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { await proxy.close(); await upstream.close(); });

  const send = (threadId) => fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt_cache_key: threadId, stream: true }),
  }).then((response) => response.text());

  const selected = send("selected");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstream.requests.length, 0);

  const bypassed = await send("bypassed");
  assert.match(bypassed, /response\.completed/);
  assert.deepEqual(upstream.requests.map(({ prompt_cache_key: id }) => id), ["bypassed"]);

  modelOnline = true;
  assert.equal(await monitor.checkNow(), true);
  assert.match(await selected, /response\.completed/);
  assert.deepEqual(upstream.requests.map(({ prompt_cache_key: id }) => id), ["bypassed", "selected"]);
});
