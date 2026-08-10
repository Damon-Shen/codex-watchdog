const BALANCE_MODES = new Set(["any", "all", "sum"]);

export function validateBalancePolicy(policy) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    !BALANCE_MODES.has(policy.mode) ||
    !Number.isFinite(policy.minimum) ||
    policy.minimum < 0
  ) {
    throw new Error("Invalid balance policy");
  }
  return { mode: policy.mode, minimum: policy.minimum };
}

function validateAccountIds(accountIds) {
  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    throw new Error("Balance accounts must not be empty");
  }
  const ids = new Set();
  for (const accountId of accountIds) {
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("Balance account IDs must be non-empty strings");
    }
    if (ids.has(accountId)) throw new Error(`Duplicate balance account ID: ${accountId}`);
    ids.add(accountId);
  }
  return ids;
}

export function normalizeBalances(records, expectedAccountIds) {
  const expected = validateAccountIds(expectedAccountIds);
  if (!Array.isArray(records)) throw new Error("Balance results must be an array");

  const byAccount = new Map();
  for (const record of records) {
    const accountId = record?.accountId;
    if (!expected.has(accountId)) throw new Error(`Unexpected balance account ID: ${accountId}`);
    if (byAccount.has(accountId)) throw new Error(`Duplicate balance account result: ${accountId}`);
    const balance = record.balance;
    if (balance !== null && (!Number.isFinite(balance) || balance < 0)) {
      throw new Error(`Invalid balance for account ${accountId}`);
    }
    byAccount.set(accountId, { accountId, balance });
  }

  for (const accountId of expected) {
    if (!byAccount.has(accountId)) throw new Error(`Missing balance account result: ${accountId}`);
  }
  return expectedAccountIds.map((accountId) => byAccount.get(accountId));
}

export function aggregateBalances(records, rawPolicy) {
  const policy = validateBalancePolicy(rawPolicy);
  const normalized = normalizeBalances(records, records?.map((record) => record?.accountId));
  const known = normalized.filter(({ balance }) => balance !== null);

  if (policy.mode === "any") {
    if (known.some(({ balance }) => balance >= policy.minimum)) return "available";
    return known.length === normalized.length ? "insufficient" : "unknown";
  }

  if (policy.mode === "all") {
    if (known.some(({ balance }) => balance < policy.minimum)) return "insufficient";
    return known.length === normalized.length ? "available" : "unknown";
  }

  const total = known.reduce((sum, { balance }) => sum + balance, 0);
  if (total >= policy.minimum) return "available";
  return known.length === normalized.length ? "insufficient" : "unknown";
}
