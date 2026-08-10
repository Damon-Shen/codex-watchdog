# Relay Balance API Research

Date: 2026-08-10

## Sub2API

The official Sub2API router registers `GET /v1/usage` behind API-key authentication. The middleware
explicitly permits expired or quota-exhausted keys to query this endpoint, which makes it suitable
for diagnosing a failed Codex request.

The official frontend calls the endpoint with `Authorization: Bearer <apiKey>` and extracts the
balance as:

```js
response?.remaining ?? response?.quota?.remaining ?? response?.balance
```

The endpoint may represent a key quota, a subscription, or a wallet. All three response modes expose
the normalized amount in USD through one of those fields.

Sources:

- [Gateway route and middleware](https://github.com/Wei-Shaw/sub2api/blob/0b3fe95afd20aba77ee7649b37febb8255fb57a5/backend/internal/server/routes/gateway.go)
- [Usage response implementation](https://github.com/Wei-Shaw/sub2api/blob/0b3fe95afd20aba77ee7649b37febb8255fb57a5/backend/internal/handler/gateway_handler.go)
- [Official frontend request and extractor](https://github.com/Wei-Shaw/sub2api/blob/0b3fe95afd20aba77ee7649b37febb8255fb57a5/frontend/src/views/user/KeysView.vue)

## New API

The official New API router registers `GET /api/usage/token/` with read-only token authentication.
The controller requires `Authorization: Bearer <token>` and returns:

```json
{
  "code": true,
  "message": "ok",
  "data": {
    "total_available": 123,
    "unlimited_quota": false
  }
}
```

`total_available` uses New API's quota units. The plugin configuration's balance threshold must use
the same unit. An unlimited token must be treated as available regardless of the numeric remaining
quota.

Sources:

- [Usage route](https://github.com/QuantumNous/new-api/blob/9c97e78aced572d540f227007a675d7d007666ac/router/api-router.go)
- [Token usage controller](https://github.com/QuantumNous/new-api/blob/9c97e78aced572d540f227007a675d7d007666ac/controller/token.go)
- [First-party key tool consumer](https://github.com/Calcium-Ion/new-api-key-tool/blob/d4a82732824af6571b9547b1e0b7726d8915d0a0/src/components/LogsTable.js)

## Adapter Consequences

- Query every configured API key independently so one failed request becomes `balance: null` without
  discarding successful accounts.
- Use a Bearer Authorization header for both stacks.
- Treat non-2xx responses, malformed JSON, missing fields, and negative/non-finite values as unknown.
- Normalize Sub2API amounts directly in USD.
- Normalize New API `total_available` in native quota units; represent an unlimited token with a
  finite sentinel above any practical configured threshold so the existing numeric aggregation
  contract remains intact.
