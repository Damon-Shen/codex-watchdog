import assert from "node:assert/strict";
import test from "node:test";

import {
  queryNewApiBalances,
  querySub2ApiBalances,
  selectBalanceAdapter,
} from "../src/balance-adapters.mjs";

function createHttp(responses) {
  const requests = [];
  return {
    requests,
    http: {
      async request(request) {
        requests.push(request);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return {
          ok: response.ok ?? true,
          status: response.status ?? 200,
          json: async () => response.body,
        };
      },
    },
  };
}

const apiKeys = [
  { id: "first", value: "sk-first" },
  { id: "second", value: "sk-second" },
  { id: "third", value: "sk-third" },
];

test("queries and normalizes every Sub2API key independently", async () => {
  const client = createHttp([
    { body: { remaining: 4.5 } },
    { body: { quota: { remaining: 2 } } },
    { body: { balance: "invalid" } },
  ]);

  const result = await querySub2ApiBalances({
    config: { baseUrl: "https://relay.example/", apiKeys },
    http: client.http,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, [
    { accountId: "first", balance: 4.5 },
    { accountId: "second", balance: 2 },
    { accountId: "third", balance: null },
  ]);
  assert.deepEqual(client.requests.map(({ url, headers }) => ({ url, authorization: headers.authorization })), [
    { url: "https://relay.example/v1/usage", authorization: "Bearer sk-first" },
    { url: "https://relay.example/v1/usage", authorization: "Bearer sk-second" },
    { url: "https://relay.example/v1/usage", authorization: "Bearer sk-third" },
  ]);
});

test("queries New API token usage and honors unlimited quota", async () => {
  const client = createHttp([
    { body: { code: true, data: { total_available: 800, unlimited_quota: false } } },
    { body: { code: true, data: { total_available: 0, unlimited_quota: true } } },
    { ok: false, status: 503, body: {} },
  ]);

  const result = await queryNewApiBalances({
    config: { baseUrl: "https://new.example", apiKeys },
    http: client.http,
  });

  assert.deepEqual(result, [
    { accountId: "first", balance: 800 },
    { accountId: "second", balance: Number.MAX_VALUE },
    { accountId: "third", balance: null },
  ]);
  assert.deepEqual(client.requests.map(({ url }) => url), [
    "https://new.example/api/usage/token/",
    "https://new.example/api/usage/token/",
    "https://new.example/api/usage/token/",
  ]);
});

test("turns per-account request and parse failures into unknown balances", async () => {
  const client = createHttp([
    new Error("offline"),
    { body: { remaining: -1 } },
    { body: { remaining: Number.NaN } },
  ]);
  assert.deepEqual(await querySub2ApiBalances({
    config: { baseUrl: "https://relay.example", apiKeys },
    http: client.http,
    logger: { warn() {} },
  }), [
    { accountId: "first", balance: null },
    { accountId: "second", balance: null },
    { accountId: "third", balance: null },
  ]);
});

test("selects only supported built-in stacks", () => {
  assert.equal(selectBalanceAdapter("sub2api"), querySub2ApiBalances);
  assert.equal(selectBalanceAdapter("newapi"), queryNewApiBalances);
  assert.throws(() => selectBalanceAdapter("custom"), /custom.*checkBalances/i);
  assert.throws(() => selectBalanceAdapter("other"), /stack/i);
});
