function endpoint(baseUrl, pathname) {
  return new URL(pathname, baseUrl).href;
}

export default function createExamplePlugin({ config, host }) {
  return {
    apiVersion: 1,
    id: "example-relay",

    async checkModel({ signal }) {
      const response = await host.http.request({
        url: endpoint(config.baseUrl, config.options.statusPath),
        signal,
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload.models?.some(
        (entry) => entry.name === config.model && entry.available === true,
      ) === true;
    },

    async checkBalances({ signal }) {
      return Promise.all(config.apiKeys.map(async ({ id, value }) => {
        try {
          const response = await host.http.request({
            url: endpoint(config.baseUrl, config.options.balancePath),
            headers: { authorization: `Bearer ${value}` },
            signal,
          });
          if (!response.ok) return { accountId: id, balance: null };
          const payload = await response.json();
          const balance = payload.remaining;
          return {
            accountId: id,
            balance: Number.isFinite(balance) && balance >= 0 ? balance : null,
          };
        } catch (error) {
          host.logger.warn(`Balance query failed for ${id}: ${error.message}`);
          return { accountId: id, balance: null };
        }
      }));
    },

    close() {},
  };
}
