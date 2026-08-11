import assert from "node:assert/strict";
import test from "node:test";

import createAiInputPlugin from "../plugins/aiinput.mjs";

function createHarness({ ok = true, status = 200, payload, jsonError } = {}) {
  const requests = [];
  const host = {
    http: {
      async request(request) {
        requests.push(request);
        return {
          ok,
          status,
          async json() {
            if (jsonError) throw jsonError;
            return payload;
          },
        };
      },
    },
  };
  return { host, requests };
}

test("returns the exact ai.input.im model status and forwards cancellation", async () => {
  for (const expected of [true, false]) {
    const signal = new AbortController().signal;
    const { host, requests } = createHarness({
      payload: {
        services: [
          { model: "gpt-5.6-sol-preview", last: { ok: !expected } },
          { model: "gpt-5.6-sol", last: { ok: expected } },
        ],
      },
    });
    const plugin = createAiInputPlugin({
      config: { model: "gpt-5.6-sol" },
      host,
    });

    assert.equal(await plugin.checkModel({ signal }), expected);
    assert.deepEqual(requests, [
      {
        url: "https://status.input.im/api/status",
        signal,
      },
    ]);
    assert.equal(plugin.apiVersion, 1);
    assert.equal(plugin.id, "aiinput");
    assert.equal(plugin.checkBalances, undefined);
  }
});

test("turns ambiguous ai.input.im responses into probe errors", async () => {
  const cases = [
    [{ ok: false, status: 503, payload: {} }, /HTTP 503/],
    [{ jsonError: new SyntaxError("invalid JSON") }, /invalid JSON/],
    [{ payload: {} }, /services array/],
    [
      { payload: { services: [{ model: "other", last: { ok: true } }] } },
      /no model/,
    ],
    [
      {
        payload: {
          services: [{ model: "gpt-5.6-sol", last: { ok: "yes" } }],
        },
      },
      /boolean status/,
    ],
  ];

  for (const [response, pattern] of cases) {
    const { host } = createHarness(response);
    const plugin = createAiInputPlugin({
      config: { model: "gpt-5.6-sol" },
      host,
    });
    await assert.rejects(() => plugin.checkModel({}), pattern);
  }
});
