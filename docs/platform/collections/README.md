# API collections

[`kletia-platform-api.postman_collection.json`](kletia-platform-api.postman_collection.json)
is a Postman Collection v2.1 with every Platform API v1 operation, grouped by
tag (System, Registry, Quotes, Portfolio, Intents, Events, Webhooks, Keys,
Usage, MCP). It is generated from [`../openapi.json`](../openapi.json), the
same document the API serves at `GET /v1/openapi.json`; do not edit either
file by hand.

## Import

| Tool | How |
|---|---|
| Postman | **Import** → the collection file (or the raw GitHub URL) |
| Insomnia | **Import** → the collection file; Insomnia converts Postman v2.1 collections |
| Bruno | **Import Collection** → Postman Collection, or OpenAPI V3 with `openapi.json` |
| Hoppscotch | **Import** → Postman collection, or OpenAPI with `openapi.json` |

Any OpenAPI 3.1 tool can also read `openapi.json` directly or
`https://api.kletiaai.xyz/v1/openapi.json`.

## Variables

| Variable | Default | Use |
|---|---|---|
| `baseUrl` | `https://api.kletiaai.xyz` | Set `http://localhost:3001` for a local or self-hosted API. |
| `apiKey` | empty | Empty is the public tier (no `Authorization` header). Issue a key with `POST /v1/keys` (Keys folder) and keep it in an environment or vault variable, never in a collection you share. |
| `intentId`, `stepId`, `webhookId`, `keyId` | empty, `s1` | Ids for the requests under a resource; copy them from earlier responses. |
| `accountId` | a demo Solana account | Portfolio lookups. |
| `transactionReference` | empty | A transaction hash or signature for the step submit request. |

The `POST /v1/intents` requests plan with `dryRun=true`: nothing is stored
and nothing is signed. Requests whose operation needs a key say so in their
description. Keyed `POST` requests carry an `Idempotency-Key: {{$guid}}`
header; set a fixed value instead to see a replay (`Idempotent-Replayed: true`).
Webhook deliveries are requests Kletia sends to you, so they are not in the
collection; see [Platform API v1](../api-v1.md) for their headers and
signature check.

## Regenerate

```bash
npm run generate:openapi   # docs/platform/openapi.json and this collection
npm run check:openapi      # fails when either file is out of date (part of npm run verify)
npm run lint:openapi       # optional deeper lint with Redocly CLI 2.54.2 (downloaded by npx)
```

`tooling/export-openapi.mjs` loads `buildOpenApiDocument()` from the API
source and lints it (references, operation ids, tags, path parameters,
security schemes); `tooling/generate-collections.mjs` converts it without
external dependencies, with stable ids so the file changes only when the
contract does.
