function endpoint(baseUrl, pathname) {
  return new URL(pathname, baseUrl).href;
}

function numericBalance(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function queryAccounts({ config, http, signal, logger, pathname, extract }) {
  return Promise.all(config.apiKeys.map(async ({ id, value }) => {
    try {
      const response = await http.request({
        url: endpoint(config.baseUrl, pathname),
        headers: { authorization: `Bearer ${value}` },
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return { accountId: id, balance: numericBalance(extract(payload)) };
    } catch (error) {
      logger?.warn?.(`Balance query failed for account ${id}: ${error?.message ?? error}`);
      return { accountId: id, balance: null };
    }
  }));
}

export function querySub2ApiBalances(context) {
  return queryAccounts({
    ...context,
    pathname: "/v1/usage",
    extract: (payload) => payload?.remaining ?? payload?.quota?.remaining ?? payload?.balance,
  });
}

export function queryNewApiBalances(context) {
  return queryAccounts({
    ...context,
    pathname: "/api/usage/token/",
    extract(payload) {
      if (payload?.code !== true || !payload.data) return null;
      if (payload.data.unlimited_quota === true) return Number.MAX_VALUE;
      return payload.data.total_available;
    },
  });
}

export function selectBalanceAdapter(stack) {
  if (stack === "sub2api") return querySub2ApiBalances;
  if (stack === "newapi") return queryNewApiBalances;
  if (stack === "custom") {
    throw new Error("Custom stack requires plugin checkBalances");
  }
  throw new Error(`Unsupported relay stack: ${stack}`);
}
