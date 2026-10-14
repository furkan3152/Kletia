# Generating clients from the OpenAPI document

`@kletia/sdk` is the maintained TypeScript client. For other languages, or a
typed client of your own, generate one from the OpenAPI 3.1 document every
deployment serves at `GET /v1/openapi.json` (the same document is checked in
as [openapi.json](openapi.json)). The served document lists its own origin
first in `servers` when the deployment sets `KLETIA_API_ORIGIN`, so a client
generated from a self-hosted or local deployment defaults to it.

```bash
curl -sS https://api.kletiaai.xyz/v1/openapi.json -o kletia-openapi.json
```

The document validates with Redocly (`npm run lint:openapi` in this
repository). Postman and Insomnia collections are in
[collections/](collections/README.md).

## TypeScript

Types only, with [`openapi-typescript`](https://openapi-ts.dev) and a small
fetch wrapper from `openapi-fetch`:

```bash
npx openapi-typescript@7 kletia-openapi.json -o src/kletia.d.ts
npm install openapi-fetch
```

```ts
import createClient from "openapi-fetch";
import type { paths } from "./kletia.d.ts";

const kletia = createClient<paths>({
  baseUrl: process.env.KLETIA_API_ORIGIN ?? "https://api.kletiaai.xyz",
  headers: { authorization: `Bearer ${process.env.KLETIA_API_KEY}` },
});

const { data, error } = await kletia.POST("/v1/intents", {
  params: { query: { dryRun: "true" } },
  body: { text: "swap 1 SOL to USDC", accounts: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] },
});
if (error) console.error(error.error.code, error.error.message);
```

The generated file is large (about 9,000 lines) and takes under a second to
produce; regenerate it when `GET /v1/health` reports a new `build.commit` you
want to use.

## Python

```bash
pipx run openapi-python-client generate --path kletia-openapi.json
```

## Go

```bash
go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest -generate types,client -package kletia kletia-openapi.json > kletia.gen.go
```

## Rules a generated client must implement itself

A generator gives you shapes, not the safety rules `@kletia/sdk` and the
widget enforce. Implement these yourself:

1. **Keys stay on your server.** `kl_dev_` and `kl_agt_` keys never go into a
   browser bundle, mobile app or snippet; read them from the environment. A
   server key sent from a browser on another site is refused with
   `403 SECRET_KEY_FROM_BROWSER`. Browsers call the public tier or your own
   server.
2. **Never retry prepare or submit automatically.** A prepare builds fresh
   transactions (re-preparing is allowed when the user asks, but a blind retry
   can hand the wallet a different quote); a submit carries hashes the user
   signed. Retry only reads, and writes that carry an `Idempotency-Key`.
3. **`Idempotency-Key` needs an API key** (`400 IDEMPOTENCY_KEY_REQUIRES_API_KEY`
   otherwise); use one unique key per logical operation and reuse it only for
   retries of that operation.
4. **Acknowledge what the user saw.** Send `acknowledgedPreview` (the preview
   digest the user reviewed) when preparing; on `409 PREVIEW_CHANGED`, show
   the new preview and ask again ([preview.md](preview.md)).
5. **Show the contract review before signing** `call` and `action` steps:
   `payload.review` (integrator, function, approvals, simulated asset
   changes, provenance and the "Not audited by Kletia" notice), with an
   explicit acknowledgement when the source or domain is unverified
   ([contracts.md](contracts.md#simulation-and-the-review)).
6. **Intent ids are capabilities.** Whoever holds `int_…` can read, prepare
   and cancel the intent; share it only with the user who signs it.
7. **Verify webhooks.** Check `Kletia-Signature`
   (`t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, with a short
   tolerance on `t`) against the raw body before parsing, and de-duplicate by `Kletia-Event-Id`: deliveries
   are retried and can arrive more than once ([api-v1.md](api-v1.md#events-and-webhooks)).
8. **Timestamps.** Every timestamp is an ISO 8601 string except
   `payload.expiresAt`, which is a number of Unix seconds.
9. **Tolerate growth.** Ignore unknown response fields and enum values, read
   `error.details` only for the fields you know, and map unknown error codes
   by HTTP status and the catalog's `retryable` flag (`GET /v1/errors`).
10. **Respect rate limits.** On `429` wait for `Retry-After`; the `RateLimit`
    and `RateLimit-Policy` headers report the current window.
