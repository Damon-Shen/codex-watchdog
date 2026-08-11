import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import createAiInputPlugin from "../plugins/aiinput.mjs";
import { loadPlugin } from "../src/plugin-loader.mjs";

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

test("ships a loadable multi-account Sub2API configuration", async () => {
  const configUrl = new URL("../plugins/aiinput.example.json", import.meta.url);
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  assert.equal(config.module, "./aiinput.mjs");
  assert.equal(config.stack, "sub2api");
  assert.equal(config.baseUrl, "https://ai.input.im");
  assert.equal(config.apiKeys.length, 2);

  const runtime = await loadPlugin("aiinput", {
    configPath: fileURLToPath(configUrl),
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.equal(runtime.plugin.id, "aiinput");
  assert.equal(runtime.plugin.checkBalances, undefined);
  await runtime.close();
});
