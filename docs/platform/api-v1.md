# Kletia Platform API v1

Kletia Platform API v1 is the integration surface for teams that want
cross-network intents in their own product. The first-party Kletia app uses
this same API for Solana and cross-network flows.

- Base URL: `https://api.kletiaai.xyz/v1` (local: `http://localhost:3001/v1`)
- Spec: `GET /v1/openapi.json` (OpenAPI 3.1)
- Types: [`@kletia/core`](../../packages/core/README.md) (intent spec), [`@kletia/sdk`](../../packages/sdk/README.md) (client)
- Errors: [errors.md](errors.md) (also `GET /v1/errors`)
- Agents: [mcp.md](mcp.md) (read-only MCP server at `/v1/mcp`)

## Design rules

1. **Non-custodial.** The API returns unsigned transactions. The user's wallet
   signs every value-moving transaction. Kletia never holds keys.
2. **Chain-agnostic identities.** Networks are CAIP-2 ids (`eip155:8453`,
   `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). Accounts are CAIP-10 ids. Assets
   are CAIP-19 ids. Amounts are decimal-integer strings in base units.
3. **Evidence over assertions.** A submitted hash or signature only moves a
   step forward after Kletia observes it on-chain from the bound account.
   Cross-network settlement completes only on settlement-network evidence.
4. **No global atomicity.** A graph is a DAG of network-bound steps. A later step
   is prepared only after its dependencies settle.
5. **One capital lane per intent.** Mainnet and testnet networks never share an
   intent graph.

## Authentication and tiers

| Tier | How | Limits | Capabilities |
|---|---|---|---|
| Public | No key | 30 requests/min per IP | Read registries, quotes, create and run intents |
| Developer | `Authorization: Bearer kl_dev_…` | 300 requests/min per key | Everything above, plus intent listing and webhooks |
| Operator | Key configured in `KLETIA_OPERATOR_API_KEYS` | 1200 requests/min per key | Everything above |

`POST /v1/keys` issues a developer key (shown once; stored only as a SHA-256
hash). It is rate-limited per IP. Keys are managed per project; see
[Key management](#key-management). Requests with an unknown or revoked key count
against the caller's IP at the public limit, and an IP is allowed 30 checks of
unrecognised keys per minute: after that, keys that are not already verified
get `429 RATE_LIMITED` (with `Retry-After`) without being looked up.

Intent ids (`int_` + 128 random bits) are capabilities: whoever holds an id can
read, prepare, submit, refresh and cancel that intent, so share it only with
the user who signs it. This is safe for funds because preparation only builds
transactions for the step's bound account, verification only accepts
transactions sent by that account, and cancellation is refused once a step has
been submitted. API keys control rate limits, listing and webhook routing; keep
`kl_dev_` keys on your server and proxy browser calls, or call the public tier
from the browser.

## Errors

```json
{ "error": { "code": "INTENT_UNSUPPORTED", "message": "…", "issues": [{ "path": "actions[0].network", "message": "…" }], "docs": "https://kletiaai.xyz/developers#error-INTENT_UNSUPPORTED" }, "requestId": "…" }
```

Codes are `UPPER_SNAKE_CASE` and stable. Every code is in the [error catalog](errors.md) (`GET /v1/errors`, `ERROR_CATALOG` in `@kletia/core`) with its status, whether a retry can help and what to do; `error.docs` links to the entry. Every response carries `X-Request-Id` (a valid incoming UUID is echoed). `INTENT_UNSUPPORTED` errors also include `hints`: example phrases the grammar understands.

| Status | When |
|---|---|
| 400 | Invalid input (`INVALID_REQUEST`, `INVALID_JSON`, `REFERENCES_INVALID`, `REFERENCE_COUNT_MISMATCH`, …) |
| 401 | Unknown, malformed or revoked API key (a bad key is never downgraded to the public tier) |
| 403 | A rotated-out secret managing keys (`KEY_SECRET_ROTATED`), a refused browser origin on `/v1/mcp` (`MCP_ORIGIN_FORBIDDEN`) |
| 404 | Unknown intent, step, webhook, key or path |
| 405 | Wrong method (with an `Allow` header) |
| 409 | State conflict (`QUOTE_MOVED`, `STEP_NOT_READY`, cancel after submission, duplicate webhook, `KEY_LIMIT_REACHED`, `KEY_NOT_MANAGEABLE`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `RECIPIENT_NAME_CHANGED`) |
| 413 / 415 | Body over 64 KB / non-JSON body |
| 422 | Understood but not executable (`INTENT_UNSUPPORTED`, `INSUFFICIENT_BALANCE`, `SELF_TRANSFER`, `FEE_LIMIT_EXCEEDED`, `CAPITAL_LANE_MIXED`, `ROUTE_UNSUPPORTED`, `ROUTE_TOO_SLOW`, `POSITION_EMPTY`, `VENUE_UNVERIFIED`, `VENUE_ILLIQUID`, `RECIPIENT_NAME_UNRESOLVED`, `WEBHOOK_URL_FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`, and the reference rejections `REFERENCE_MISMATCH`, `REFERENCE_WRONG_SENDER`, `REFERENCE_WRONG_CHAIN`, `REFERENCE_ALREADY_USED`, `REFERENCE_STALE`) |
| 429 | Rate limited (with `Retry-After`) |
| 502 / 503 | Upstream provider unavailable, or a feature not configured (`WEBHOOKS_NOT_CONFIGURED`) |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | public | API and per-network RPC health |
| GET | `/v1/networks` | public | Chain registry plus per-network capabilities |
| GET | `/v1/protocols` | public | Protocol registry |
| GET | `/v1/assets?network=` | public | Canonical asset registry |
| GET | `/v1/venues?network=&protocol=` | public | EVM lending venues with supply APY, size and exit liquidity (advisory, cached 60 s) |
| POST | `/v1/quotes` | public | Best routes for one asset movement (same- or cross-network) |
| GET | `/v1/portfolio/{accountId}` | public | Balances for one CAIP-10 account |
| POST | `/v1/intents` | public | Plan an intent into an `IntentGraph` (`?dryRun=true` to skip persistence) |
| GET | `/v1/intents` | key | List intents created with the caller's key |
| GET | `/v1/intents/{id}` | public | Read an intent |
| POST | `/v1/intents/{id}/steps/{stepId}/prepare` | public | Build wallet-ready transactions for a ready step |
| POST | `/v1/intents/{id}/steps/{stepId}/submit` | public | Submit transaction hashes / signatures for verification |
| POST | `/v1/intents/{id}/refresh` | public | Re-read settlement state now |
| POST | `/v1/intents/{id}/cancel` | public | Cancel an intent with no submitted steps |
| GET | `/v1/intents/{id}/events` | public | Server-Sent Events stream of intent events |
| POST | `/v1/webhooks` | key | Register a webhook (secret returned once) |
| GET | `/v1/webhooks` | key | List webhooks |
| DELETE | `/v1/webhooks/{id}` | key | Delete a webhook and its delivery log |
| POST | `/v1/webhooks/{id}/test` | key | Send a signed `webhook.test` event now |
| GET | `/v1/webhooks/{id}/deliveries` | key | Delivery log (`?limit=1..100`) |
| POST | `/v1/keys` | public | Issue a developer key (with a developer key: a sibling in the same project) |
| GET | `/v1/keys` | key | List the keys of the caller's project |
| POST | `/v1/keys/{id}/rotate` | key | New secret for a key, same id, with a grace window |
| DELETE | `/v1/keys/{id}` | key | Revoke a key |
| GET | `/v1/usage` | key | Requests, status classes, rate-limit window and intents of the caller's key |
| GET | `/v1/errors` | public | Error catalog |
| GET | `/v1/status/badge` | public | Status badge (SVG, or `?format=shields`) |
| POST | `/v1/mcp` | public | Model Context Protocol server ([mcp.md](mcp.md)) |
| GET | `/v1/openapi.json` | public | OpenAPI document |

### `POST /v1/intents`

Request body: `IntentRequest` from `@kletia/core`.

```json
{
  "text": "bridge 25 USDC from base to solana then swap half to JitoSOL",
  "accounts": [
    "eip155:8453:0x1111111111111111111111111111111111111111",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
  ],
  "constraints": { "maxSlippageBps": 50 },
  "metadata": { "orderId": "A-1029" }
}
```

Structured alternative:

```json
{
  "actions": [
    { "kind": "bridge", "network": "base", "from": "USDC", "amount": "25", "toNetwork": "solana", "to": "USDC" },
    { "kind": "swap", "network": "solana", "from": "USDC", "to": "JitoSOL", "amount": "max" }
  ],
  "accounts": ["…"]
}
```

`amount: "max"` on a dependent step means "the guaranteed output of the
previous step"; on a `withdraw` it closes the whole position at the venue
("withdraw all"). Response: `201 { "intent": IntentGraph }`. A dry run returns `200` and is not stored. Repeating a `clientReference` returns the original intent with `200` and `Idempotent-Replayed: true`.

Action and constraint options:

- `actions[].recipient` takes an address, a CAIP-10 account or a name:
  `*.eth` (ENS), `*.base.eth` (Basenames) or `*.sns` (SNS). See
  [Recipient names](#recipient-names).
- `actions[].params.venue` picks a lending venue for a `deposit` or
  `withdraw`: a registry id such as `base:morpho:steakhouse-prime-usdc`, its
  slug, or the vault / market address on that network (a market address that
  several reserves share, such as an Aave V3 Pool, picks the reserve of the
  input asset). Without it the planner
  uses the named protocol's default venue for the asset (or the first lending
  protocol with an executable venue) and says so in the step's warnings. The
  chosen id is returned as `step.venue`.
- `constraints.maxSeconds` (10-86400, default 600) is the longest settlement
  estimate a cross-network step may take; see [Bridge auction](#bridge-auction).
  `constraints.preferProtocols` / `avoidProtocols` steer or exclude venues,
  and `protocol` on a bridge action ("via lifi") names a single venue.

Steps also carry `venue` (deposit / withdraw), `recipientName` (the name the
recipient was resolved from) and `extraCosts` (value paid on top of the input,
such as a deBridge fixed fee in the native asset, with `usd` when priced).

`GET /v1/intents` accepts `?limit=1..100` (default 20).

### `POST /v1/quotes`

```json
{
  "from": { "network": "base", "asset": "USDC", "amount": "25", "account": "eip155:8453:0x1111111111111111111111111111111111111111" },
  "to": { "network": "solana", "asset": "USDC", "recipient": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
  "slippageBps": 50
}
```

`from.account` and `to.recipient` are optional. Without them Kletia quotes with
neutral stand-in accounts, which is accurate for pricing but not executable.

Response: `{ routes, best, quotedAt, unavailable }`. Each route carries `protocol`, `input`, `output`, `minimumOutput`, `feesUsd`, `estimatedSeconds`, `transactionCount`, `settlement` and `eligible`, plus `extraCosts` and `netMinimumOutput` (the minimum net of priced extra costs) when a venue charges on top of the input. Routes are ranked like the [bridge auction](#bridge-auction); `best` is the first `eligible` route, and `maxSeconds` in the body (10-86400, default 600) sets the time limit. `unavailable` lists venues that could not quote with the reason. A flat body (`network`, `from`, `to`, `toNetwork`, `amount`) is also accepted.

### Bridge auction

For every cross-network `bridge` step the planner asks each venue that serves
the route (Relay, LI.FI, deBridge DLN) for a quote in parallel, with an 8 s
timeout per venue, and picks the winner by:

1. the highest guaranteed output net of extra costs (a venue whose extra costs
   cannot be priced is not eligible);
2. then the shortest settlement estimate within `constraints.maxSeconds`;
3. then the fewest transactions.

Losing and failing quotes are recorded as `quote` evidence on the step.
`preferProtocols` puts venues first, `avoidProtocols` never quotes them, and a
named venue ("bridge 25 USDC from base to arbitrum via lifi") skips the
auction. At prepare, an extra cost above the planned amount plus the step's
slippage, or one the plan did not have, is refused with `409 QUOTE_MOVED`.
Every venue's contracts and programs are pinned in the registry
(`VENUE_CONTRACTS`); see [cross-chain venues](../networks/cross-chain-venues.md).

### Recipient names

`*.eth` resolves through the pinned ENS Universal Resolver (off-chain
CCIP-Read resolvers are refused), `*.base.eth` through the Base registry's
resolver, and `*.sns` to the SNS registry owner on Solana. `.sol` names are
refused while SNS has them paused. Off Ethereum, an ENS name's own record for
the network comes first, then its default EVM record; its Ethereum record is
used only for an externally owned account (EIP-7702 delegations included) or a contract deployed on the target network, with a warning. The
resolved address is the step's `recipient`, the name is `recipientName`, and
the resolution is recorded as evidence. The name is resolved again before
every prepare: a different address returns `409 RECIPIENT_NAME_CHANGED`. A
name with no address for the network returns `422 RECIPIENT_NAME_UNRESOLVED`;
an unsupported kind of name, `422 RECIPIENT_NAME_UNSUPPORTED`.

### Step execution

1. `GET /v1/intents/{id}` → find steps with `status: "ready"`.
2. `POST …/steps/{stepId}/prepare` → `{ "payload": StepExecutionPayload, "intent": IntentGraph }`.
   `payload.transactions` are signed and sent **in order** by the wallet that
   owns `step.account`:
   - EVM (`vm: "evm"`): `eth_sendTransaction` with `{ from, to, data, value }`.
   - Solana (`vm: "svm"`): sign and send the base64 v0 transaction
     (`solana:signAndSendTransaction`).
3. `POST …/steps/{stepId}/submit` with `{ "references": ["0x…" | "<base58 signature>"] }`,
   one reference per transaction, in order.
   A step takes at most 4 references.
4. Kletia verifies each reference on-chain. Same-network steps become
   `settled`; cross-network steps become `settling` until the settlement network
   reports a destination fill, then `settled` (or `failed` on refund/expiry).

Submission outcomes:

| Outcome | Step | Response |
|---|---|---|
| Verified on-chain | `settled` (same network) or `settling` (cross-network) | `200` |
| Not yet visible on-chain | `submitted`; re-verified by refresh and the settlement poller | `200` |
| Provably not this step's transactions (`REFERENCE_MISMATCH`, `REFERENCE_WRONG_SENDER`, `REFERENCE_WRONG_CHAIN`, `REFERENCE_STALE`, `REFERENCE_ALREADY_USED`) | unchanged | `422` |
| Landed but failed (`TRANSACTION_FAILED` on Solana, `TRANSACTION_REVERTED` on EVM) or never landed before its blockhash expired (`TRANSACTION_EXPIRED`) | `failed`, with `step.failure` | `200` |
| Destination fill does not match the quoted route (`SETTLEMENT_MISMATCH`) | `failed`, with `step.failure` | via refresh / events |

While a step's stored references have produced no on-chain evidence, a new
submission replaces them (for example after a wallet speed-up or a resend with
a fresh blockhash). Once a reference is verified, it is bound to the step and
cannot be reused by any other step.

A payload expires at `payload.expiresAt`; prepare again to re-quote. `payload.quoteBinding` is a SHA-256 over each transaction's chain, sender, target, calldata and value (EVM) or fee payer and program (Solana); the landed transactions must match a prepared payload. Re-preparing is allowed, and an older payload that lands later still verifies. For Solana steps, `step.prepared.transactions[].to` holds the invoked program id.

EVM steps verify plain wallets (the receipt sender must be the step account). Smart-contract wallets that relay through bundlers are not yet supported.

A cross-network step settles only when the destination transaction named by
the settlement venue credits the step's recipient with at least the guaranteed
minimum output, was mined after the step was prepared, and has not settled any
other step for that recipient. Kletia cannot yet prove on-chain that a fill
pays for one specific deposit (the venues do not expose that link in a form
Kletia can verify for every route), so the venue's status report remains a
trust assumption for which of the recipient's qualifying credits is the fill.

### Events and webhooks

Event envelope (`KletiaEvent` in `@kletia/core`):

```json
{ "id": "evt_…", "type": "intent.step_updated", "at": "2026-10-08T12:00:00.000Z", "data": { "intentId": "…", "stepId": "…", "network": "solana", "status": "settled" } }
```

Types: `intent.created`, `intent.status_changed`, `intent.step_updated`, and
`webhook.test` (only from `POST /v1/webhooks/{id}/test`).

The SSE stream starts with `retry: 3000`, replays buffered events after `Last-Event-ID` (or `?since=<event id>`), then streams live events with a heartbeat comment every 15 s. Each API key and each client IP may hold 10 open streams (a stream opened with a key counts against both); a stream closes after 30 minutes. Replays and webhook retries can deliver an event more than once; de-duplicate by `id`.

Webhook deliveries are `POST` with header
`Kletia-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
Verify with `verifyWebhookSignature` from `@kletia/core`. Deliveries also carry
`Kletia-Event-Id`, `Kletia-Event-Type`, `Kletia-Webhook-Id` and
`Kletia-Delivery-Attempt`, and retry up to 3 times (1 s, 5 s, 25 s); redirects
are never followed. Webhook URLs must be public HTTPS; private, loopback,
link-local and metadata addresses are refused at registration and again at
every delivery. A key may register 10 webhooks.

Each key's deliveries are queued separately and served in turn with other
keys: at most 200 wait per key (beyond that the key's oldest delivery is
dropped), at most 2 are in flight per key and a webhook receives one delivery
at a time. A webhook whose last 5 attempts failed is paused for 30 s, doubling
up to 5 minutes while it keeps failing; its deliveries wait during the pause.

Webhook secrets are encrypted at rest with `KLETIA_PLATFORM_SECRET` (at least
32 characters). It is required whenever `KLETIA_DATABASE_URL` is set; with the
in-memory store a development key is used and `GET /v1/health` reports
`webhooks.sealing: "development_fallback"`. `webhooks.dispatcher` reports the
delivery queue of the answering API process.

## Idempotency

Keyed `POST` requests that create or change state accept an
`Idempotency-Key` header (draft-ietf-httpapi-idempotency-key-header):
`POST /v1/intents`, `/intents/{id}/cancel`, `/intents/{id}/steps/{stepId}/submit`,
`POST /v1/webhooks`, `POST /v1/keys` and `/keys/{id}/rotate`.

```http
POST /v1/intents
Authorization: Bearer kl_dev_…
Idempotency-Key: 7f6c1d0e-3b8a-4c2e-9a51-0d2f5b8e6a14
```

- The value is 1-128 characters from `A-Z a-z 0-9 _ . : -`, bare or as a
  quoted string (a UUID works). Anything else: `400 IDEMPOTENCY_KEY_INVALID`.
- Keys are scoped to the API key. The first response is stored for 24 hours
  (before it is written to the client) and a retry with the same key and the
  same request (method, path, query and body) replays it with
  `Idempotent-Replayed: true`, including stored client errors.
- Same key, different request: `422 IDEMPOTENCY_KEY_REUSED`. Same key while the
  first request still runs: `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` with
  `Retry-After: 1`; a reservation whose request never finished is taken over
  after 120 seconds.
- `5xx`, `429` and errors whose code is retryable in the catalog are not
  stored, so the retry runs again.
- Without an API key: `400 IDEMPOTENCY_KEY_REQUIRES_API_KEY`. On `prepare`
  (which re-quotes on every call and must never be replayed):
  `400 IDEMPOTENCY_NOT_SUPPORTED`. Dry runs ignore the header. Other POSTs
  (quotes, refresh, webhook tests, MCP) are safe to repeat and ignore it.
- Responses that carry a secret (API keys, webhook signing secrets) are stored
  encrypted with `KLETIA_PLATFORM_SECRET`, with a hash of the secret that
  made the request. After a rotation they are replayed to the key's current
  secret and to the secret that made the request, so a key that rotated
  itself and lost the response gets its new secret by retrying with the old
  one during the grace window. Any other rotated-out secret gets
  `403 KEY_SECRET_ROTATED`. With `graceSeconds: 0` the old secret stops at
  once and cannot fetch a lost response; keep a grace window, or rotate from
  a sibling key, when that matters.

`clientReference` on `POST /v1/intents` keeps working as before.

## Key management

A key issued without a key starts a **project**; a key issued with a
developer key (`POST /v1/keys` with `Authorization`) joins the caller's
project. A project holds at most 5 active keys (`409 KEY_LIMIT_REACHED`).
Intents, webhooks and usage belong to the individual key, not the project, so
use one key per environment.

- `GET /v1/keys` lists the project's keys (newest first) with `last4`,
  `createdAt`, `lastUsedAt` (updated at most once a minute), `rotatedAt`,
  `previousExpiresAt`, `revokedAt` and `current` (the calling key). Secrets
  are never returned.
- `POST /v1/keys/{id}/rotate` with `{ "graceSeconds": 0..604800 }` (default
  86400) returns `{ key }` with a new secret and the **same id**. The previous
  secret keeps authenticating until `previousExpiresAt`, but cannot manage keys
  (`403 KEY_SECRET_ROTATED`), so a leaked secret cannot take a rotated key over.
  Rotating again ends an earlier grace window; `graceSeconds: 0` ends it now.
- `DELETE /v1/keys/{id}` revokes a key (idempotent, `204`). A key may revoke
  itself. The key's webhooks and their delivery logs are deleted with it, and
  events of its intents are no longer delivered to any webhook. If the
  cleanup fails the call answers `503`; repeating it finishes the cleanup.
- Revocation and the end of a grace window take effect at once on the
  instance that handled them and within 15 seconds on every other instance.
- Operator keys are configuration and cannot be listed, rotated or revoked
  (`409 KEY_NOT_MANAGEABLE`).

## Webhook tests and delivery logs

- `POST /v1/webhooks/{id}/test` sends one signed event
  `{ "id": "evt_…", "type": "webhook.test", "at": "…", "data": { "webhookId": "wh_…" } }`
  synchronously, with the same signature, network guard, 5 s timeout and
  no-redirect rule as real deliveries, and returns `200 { delivery }` whatever
  the endpoint answered. At most 5 per minute per webhook; test failures never
  pause a webhook.
- `GET /v1/webhooks/{id}/deliveries?limit=20` returns the newest attempts:
  `{ id, eventId, eventType, intentId?, attempt, status: succeeded | failed | dropped, httpStatus?, durationMs?, error?, nextRetryAt?, test?, at }`.
  `error` is a class (`timeout`, `connection_failed`, `http_status`,
  `redirect`, `forbidden_address`, `queue_full`); payloads and error text are
  never stored. Logs are kept 7 days (at most 1000 entries per webhook; 100
  with in-memory storage) and deleted with the webhook.

## Usage

`GET /v1/usage?window=24h|7d` (key) reports the caller's key:

```json
{
  "keyId": "key_…", "tier": "developer", "window": "24h", "since": "…", "generatedAt": "…",
  "rateLimit": { "limit": 300, "remaining": 287, "resetAt": "…", "windowSeconds": 60 },
  "totals": { "requests": 1342, "byStatusClass": { "2xx": 1301, "4xx": 41 } },
  "byRoute": [{ "route": "POST /intents", "requests": 120, "byStatusClass": { "2xx": 118, "4xx": 2 } }],
  "series": [{ "hour": "…", "requests": 51 }],
  "intents": { "created": 120, "byStatus": { "completed": 97, "planned": 23 } }
}
```

Requests are counted per hour, route template and status class and written
every 30 seconds (per request on serverless hosts). `rateLimit` is the current
window on the answering instance.

## Status badge

`GET /v1/status/badge` returns an SVG badge (`operational`, `degraded` or
`down`, from the health report). With `?format=shields` it returns a
shields.io endpoint document:
`https://img.shields.io/endpoint?url=https%3A%2F%2Fapi.kletiaai.xyz%2Fv1%2Fstatus%2Fbadge%3Fformat%3Dshields`.

## Supported intents (v1)

| Kind | Networks | Venue |
|---|---|---|
| `swap` | Solana | Jupiter |
| `swap` | Base, Arbitrum | Relay (same-network) |
| `stake` (liquid) | Solana | Jupiter route into JitoSOL / mSOL / JupSOL |
| `transfer` | All | Native / ERC-20 / SPL (with ATA creation); recipients may be ENS, Basenames or SNS names |
| `bridge` (and bridge-and-swap) | Any pair of Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS and Solana a venue serves | Auction of Relay, LI.FI (Across, Polymer CCTP) and deBridge DLN |
| `deposit` / `withdraw` | Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS | Aave V3 |
| `deposit` / `withdraw` | Base, Arbitrum One, Ethereum, OP Mainnet | Compound V3 (Comet) |
| `deposit` / `withdraw` | Base, Arbitrum One, Ethereum | Morpho vaults (MetaMorpho, Vault V2; allowlisted) |
| `deposit` / `withdraw` | Base, OP Mainnet | Moonwell (WETH markets pay withdrawals in ETH) |
| `deposit` / `withdraw` | Solana | Jupiter Lend, Kamino (Kamino withdrawals take an exact amount) |

`GET /v1/venues` lists the EVM lending venues (Aave V3, Compound V3, Morpho,
Moonwell) with their registry id (usable as `params.venue`), supply APY,
supplied amount, exit liquidity and utilization, read on-chain and cached for
60 seconds; these values are advisory. Solana venues report their rate in the
plan's step warnings.

Every lending venue is pinned in the registry (`YIELD_VENUES` in
`@kletia/core`) and re-checked on-chain at plan and prepare; a venue whose
on-chain state disagrees is refused with `422 VENUE_UNVERIFIED`. Deposits and
withdrawals pay the acting account; verification requires the venue's own
events or token movements bound to the prepared payload.

Natural-language text is compiled by a deterministic grammar (no model
involved). Unsupported wording returns `422 INTENT_UNSUPPORTED` with examples.
