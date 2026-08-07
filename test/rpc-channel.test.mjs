import assert from "node:assert/strict";
import test from "node:test";

import { RpcChannel } from "../src/rpc-channel.mjs";

test("uses isolated string ids and consumes only watchdog responses", async () => {
  const sent = [];
  const channel = new RpcChannel({
    send: (message) => sent.push(JSON.parse(message)),
    timeoutMs: 1_000,
  });

  const pending = channel.request("thread/goal/get", { threadId: "thread-1" });
  assert.match(sent[0].id, /^goal-watchdog:/);
  assert.equal(sent[0].method, "thread/goal/get");

  const tuiResponse = channel.consume({ id: 42, result: {} });
  assert.equal(tuiResponse, false);

  const consumed = channel.consume({
    id: sent[0].id,
    result: { goal: { status: "blocked" } },
  });
  assert.equal(consumed, true);
  assert.deepEqual(await pending, { goal: { status: "blocked" } });
});

test("rejects an internal request when app-server returns an error", async () => {
  const sent = [];
  const channel = new RpcChannel({
    send: (message) => sent.push(JSON.parse(message)),
    timeoutMs: 1_000,
  });

  const pending = channel.request("thread/goal/get", { threadId: "thread-1" });
  channel.consume({
    id: sent[0].id,
    error: { code: 401, message: "invalid thread", data: { kind: "unauthorized" } },
  });

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /invalid thread/);
    assert.equal(error.code, 401);
    assert.deepEqual(error.data, { kind: "unauthorized" });
    return true;
  });
});
