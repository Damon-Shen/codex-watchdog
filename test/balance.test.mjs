import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateBalances,
  normalizeBalances,
  validateBalancePolicy,
} from "../src/balance.mjs";

const records = (...balances) => balances.map((balance, index) => ({
  accountId: `account-${index + 1}`,
  balance,
}));

test("aggregates any policy across available, insufficient, and unknown balances", () => {
  assert.equal(aggregateBalances(records(2, 0), { mode: "any", minimum: 1 }), "available");
  assert.equal(aggregateBalances(records(0, 0), { mode: "any", minimum: 1 }), "insufficient");
  assert.equal(aggregateBalances(records(0, null), { mode: "any", minimum: 1 }), "unknown");
});

test("aggregates all policy across available, insufficient, and unknown balances", () => {
  assert.equal(aggregateBalances(records(2, 1), { mode: "all", minimum: 1 }), "available");
  assert.equal(aggregateBalances(records(2, 0, null), { mode: "all", minimum: 1 }), "insufficient");
  assert.equal(aggregateBalances(records(2, null), { mode: "all", minimum: 1 }), "unknown");
});

test("aggregates sum policy without treating unknown balances as zero", () => {
  assert.equal(aggregateBalances(records(2, 3), { mode: "sum", minimum: 4 }), "available");
  assert.equal(aggregateBalances(records(1, 2), { mode: "sum", minimum: 4 }), "insufficient");
  assert.equal(aggregateBalances(records(1, null), { mode: "sum", minimum: 4 }), "unknown");
  assert.equal(aggregateBalances(records(4, null), { mode: "sum", minimum: 4 }), "available");
});

test("normalizes a complete account result set in configured order", () => {
  assert.deepEqual(normalizeBalances([
    { accountId: "second", balance: null },
    { accountId: "first", balance: 2.5 },
  ], ["first", "second"]), [
    { accountId: "first", balance: 2.5 },
    { accountId: "second", balance: null },
  ]);
});

test("rejects invalid balance policies and malformed account results", () => {
  for (const policy of [null, {}, { mode: "some", minimum: 1 }, { mode: "any", minimum: -1 }]) {
    assert.throws(() => validateBalancePolicy(policy), /balance policy/i);
  }
  assert.throws(() => aggregateBalances([], { mode: "any", minimum: 1 }), /balance/i);
  assert.throws(
    () => normalizeBalances(records(1, 2), ["account-1", "account-1"]),
    /duplicate/i,
  );
  assert.throws(
    () => normalizeBalances([{ accountId: "account-1", balance: Number.NaN }], ["account-1"]),
    /balance/i,
  );
  assert.throws(
    () => normalizeBalances([{ accountId: "account-1", balance: -1 }], ["account-1"]),
    /balance/i,
  );
  assert.throws(
    () => normalizeBalances([{ accountId: "other", balance: 1 }], ["account-1"]),
    /account/i,
  );
});
