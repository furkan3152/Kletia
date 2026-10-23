# Kletia Platform API v1

Kletia Platform API v1 is the integration surface for teams that want
cross-network intents in their own product. The first-party Kletia app uses
this same API for Solana and cross-network flows.

- Base URL: `https://api.kletiaai.xyz/v1` (local: `http://localhost:3001/v1`); what is live and which commit it runs: [status.md](status.md)
- Spec: `GET /v1/openapi.json` (OpenAPI 3.1); generating clients: [codegen.md](codegen.md)
- Types: [`@kletia/core`](../../packages/core/README.md) (intent spec), [`@kletia/sdk`](../../packages/sdk/README.md) (client)
- Errors: [errors.md](errors.md) (also `GET /v1/errors`)
- Agents: [mcp.md](mcp.md) (read-only MCP server at `/v1/mcp`)
- Custom contracts and sessions: [contracts.md](contracts.md)

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
| Developer | `Authorization: Bearer kl_dev_…` | 300 requests/min per key | Everything above, plus intent listing, webhooks, [custom contracts and sessions](contracts.md) |
| Sandbox | A developer key issued with `"sandbox": true` | As developer | As developer, on testnets only ([sandbox keys](#sandbox-keys)) |
| Agent | `Authorization: Bearer kl_agt_…` (a child key, [policies.md](policies.md#agent-keys)) | As developer | What its rule book chain permits |
| Publishable | `Authorization: Bearer kl_pub_…` from an allowed browser origin ([projects.md](projects.md#publishable-keys)) | 120 requests/min per key, plus 30/min per IP | The public tier, intents it owns (never contract steps), sessions from the project's stored flows, the project profile |
| Operator | Key configured in `KLETIA_OPERATOR_API_KEYS` | 1200 requests/min per key | Everything above, plus suspending any contract registration |

`POST /v1/keys` issues a developer key (shown once; stored only as a SHA-256
hash). It needs no key; the body names the key and can ask for a sandbox key:

```bash
curl -sS -X POST https://api.kletiaai.xyz/v1/keys \
  -H 'content-type: application/json' \
  -d '{ "name": "acme-dev", "sandbox": true }'
```

```json
{ "key": { "id": "key_3f2a9c0e1b7d4a6c8e0f1a2b", "name": "acme-dev", "tier": "developer", "createdAt": "2026-10-14T09:12:03.417Z", "key": "kl_dev_…", "lane": "testnet" } }
```

| Field | Type | |
|---|---|---|
| `name` | string, 1-64 printable characters | required |
| `sandbox` | boolean, default `false` | `true`: a [sandbox key](#sandbox-keys) |

At most 5 keys are issued per hour per IP; a request refused with a 4xx (an
invalid body, `409 KEY_LIMIT_REACHED`) does not count against that budget.
Keys are managed per project; see [Key management](#key-management). Requests with an unknown or revoked key count
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

### Sandbox keys

A sandbox key (`"sandbox": true`) is an ordinary developer key issued with a
key-level rule book that keeps it on the testnet lane:

```json
{ "schema": "kletia.policy/v1", "label": "Sandbox", "networks": { "lanes": ["testnet"] } }
```

It plans and stores intents on Arbitrum Sepolia, Arc Testnet and Solana
Devnet (transfers and own contracts on the two EVM testnets, transfers and
Solana Actions on Solana Devnet); anything on a production network is
refused with `403 POLICY_VIOLATION` (rule `networks.lanes`). Testnet
registrations and intent links activate at once, so a sandbox key is the
fastest way to try stored intents, webhooks and [own contracts](contracts.md#testnet-first).
For mainnet dry runs use the keyless public tier. The rule book follows the
normal [Rule Book](policies.md) rules (tighten now, loosen later), and
`GET /v1/keys` reports every key's `lane`: `testnet`, `production` or `any`,
derived from the active rule books of its chain.

### Publishable keys

A publishable key (`kl_pub_` + 32 base62, issued by `POST
/v1/projects/current/publishable-keys`) is the browser key of a project. It
works only from the origins in the project's `allowedOrigins` (`Origin`, or
`Kletia-Host-Origin` from the Kletia `/embed` frame; `403
PUBLISHABLE_ORIGIN_FORBIDDEN` otherwise), may call only the public tier,
`POST /v1/intents` (owned by the key, never `call` or `action` steps), `POST
/v1/sessions` with `{ flow, hostOrigin }` and `GET /v1/publishable/profile`
(`403 PUBLISHABLE_KEY_FORBIDDEN` for anything else), and its intents count in
its own Rule Book spend windows. The guide is [projects.md](projects.md).

### Server keys in browsers

`kl_dev_` and `kl_agt_` keys are server keys. A request that presents one with
an `Origin` header from another site answers `403 SECRET_KEY_FROM_BROWSER`
before the key is even looked up: a key in browser JavaScript is a key every
visitor can copy. Server code sends no `Origin` and is unaffected; the
first-party Kletia origins (and `CORS_ORIGINS`, `KLETIA_WEB_ORIGIN`) stay
allowed, so the developer portal can manage keys. `/v1/mcp` keeps its own
[Origin rule](mcp.md). Call Kletia from your server,
through a proxy that forwards only browser-safe routes, or use the public tier
in the browser. Operators can list exceptions for prototypes in
`KLETIA_SECRET_KEY_BROWSER_ORIGINS` (comma-separated exact origins).

## Errors

```json
{ "error": { "code": "INTENT_UNSUPPORTED", "message": "…", "issues": [{ "path": "actions[0].network", "message": "…" }], "docs": "https://kletiaai.xyz/developers#error-INTENT_UNSUPPORTED" }, "requestId": "…" }
```

Some codes add `error.details`, a JSON object of at most 4 KB with structured
context: `SOURCE_REQUIRED` `{ asset, amount, toNetwork, candidates }`,
`SOURCE_UNREACHABLE` `{ sourceNetwork, actionNetwork, asset, kind }`,
`SESSION_EXPIRES_BEFORE_ACTIVATION` `{ contract, activatesAt, expiresAt, minimumExpiresInSeconds }`.
Read the fields you need and ignore unknown ones; `details` never carries
provider text or secrets.

Codes are `UPPER_SNAKE_CASE` and stable. Every code is in the [error catalog](errors.md) (`GET /v1/errors`, `ERROR_CATALOG` in `@kletia/core`) with its status, whether a retry can help and what to do; `error.docs` links to the entry. Every response carries `X-Request-Id` (a valid incoming UUID is echoed). `INTENT_UNSUPPORTED` errors also include `hints`: example phrases the grammar understands.

| Status | When |
|---|---|
| 400 | Invalid input (`INVALID_REQUEST`, `INVALID_JSON`, `REFERENCES_INVALID`, `REFERENCE_COUNT_MISMATCH`, …) |
| 401 | Unknown, malformed or revoked API key (a bad key is never downgraded to the public tier) |
| 403 | A server key sent from a browser on another site (`SECRET_KEY_FROM_BROWSER`), a publishable key outside its operations or origins (`PUBLISHABLE_KEY_FORBIDDEN`, `PUBLISHABLE_ORIGIN_FORBIDDEN`), a rotated-out secret managing keys or registering contracts (`KEY_SECRET_ROTATED`), a refused browser origin on `/v1/mcp` (`MCP_ORIGIN_FORBIDDEN`), a session used from another site (`SESSION_ORIGIN_FORBIDDEN`), a Rule Book refusal (`POLICY_VIOLATION`, …) |
| 404 | Unknown intent, step, webhook, key, contract registration (`CONTRACT_NOT_FOUND`, also for other keys' private ones), session or path; no kept preview (`PREVIEW_NOT_FOUND`); unknown or unshared receipt, share or log batch (`RECEIPT_NOT_FOUND`, `RECEIPT_SHARE_NOT_FOUND`, `RECEIPT_LOG_NOT_FOUND`) |
| 405 | Wrong method (with an `Allow` header) |
| 409 | State conflict (`QUOTE_MOVED`, `STEP_NOT_READY`, cancel after submission, duplicate webhook, `KEY_LIMIT_REACHED`, `KEY_NOT_MANAGEABLE`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `RECIPIENT_NAME_CHANGED`, `CONTRACT_EXISTS`, `CONTRACT_LIMIT_REACHED`, `CONTRACT_PENDING`, `CONTRACT_SUSPENDED`, `CONTRACT_CHANGED`, `CONTRACT_REVISION_CHANGED`, `SESSION_USED`, `PREVIEW_CHANGED`, `RECEIPT_NOT_READY`, `RECEIPT_NOT_APPLICABLE`, `RECEIPT_SHARE_LIMIT`, `RECEIPT_ANCHOR_EXISTS`) |
| 410 | Expired (`INTENT_EXPIRED`, `DEADLINE_PASSED`, `SESSION_EXPIRED`, `RECEIPT_SHARE_EXPIRED`, `RECEIPT_DISCLOSURES_WITHDRAWN`) |
| 413 / 415 | Body over 64 KB / non-JSON body |
| 422 | Understood but not executable (`INTENT_UNSUPPORTED`, `SOURCE_REQUIRED`, `SOURCE_UNREACHABLE`, `SESSION_EXPIRES_BEFORE_ACTIVATION`, `INSUFFICIENT_BALANCE`, `SELF_TRANSFER`, `FEE_LIMIT_EXCEEDED`, `CAPITAL_LANE_MIXED`, `ROUTE_UNSUPPORTED`, `ROUTE_TOO_SLOW`, `POSITION_EMPTY`, `VENUE_UNVERIFIED`, `VENUE_ILLIQUID`, `RECIPIENT_NAME_UNRESOLVED`, `WEBHOOK_URL_FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`, the custom contract refusals (`CONTRACT_UNKNOWN`, `CONTRACT_DENIED`, `CONTRACT_FUNCTION_FORBIDDEN`, `CONTRACT_NOT_DEPLOYED`, `SIMULATION_ASSET_CHANGE_REFUSED`, `ACTION_TRANSACTION_REJECTED`, …), and the reference rejections `REFERENCE_MISMATCH`, `REFERENCE_WRONG_SENDER`, `REFERENCE_WRONG_CHAIN`, `REFERENCE_ALREADY_USED`, `REFERENCE_STALE`) |
| 429 | Rate limited (with `Retry-After`) |
| 502 / 503 | Upstream provider unavailable (`ACTION_ENDPOINT_UNAVAILABLE` for an integrator's Solana Action server), or a feature not configured or disabled (`WEBHOOKS_NOT_CONFIGURED`, `CONTRACTS_DISABLED`, `SIMULATION_UNAVAILABLE`, `RECEIPTS_DISABLED`) |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | public | API and per-network RPC health |
| GET | `/v1/networks` | public | Chain registry plus per-network capabilities |
| GET | `/v1/protocols` | public | Protocol registry, with each protocol's execution `surface` and `routedVia` ([protocols](#protocols)) |
| GET | `/v1/assets?network=` | public | Canonical asset registry |
| GET | `/v1/venues?network=&protocol=` | public | EVM lending venues with supply APY, size and exit liquidity (advisory, cached 60 s) |
| POST | `/v1/quotes` | public | Best routes for one asset movement (same- or cross-network) |
| GET | `/v1/portfolio?accounts=` | public | Balances of up to 12 CAIP-10 accounts in one request (`?positions=true`; [portfolios](#portfolios)) |
| GET | `/v1/portfolio/{accountId}` | public | Balances for one CAIP-10 account, priced with `priceSource` (`?positions=true` adds venue positions) |
| POST | `/v1/intents` | public | Plan an intent into an `IntentGraph` (`?dryRun=true` to skip persistence, `?preview=true` for the [asset-change preview](preview.md), `?journey=true` for the [journey](journey.md), `?clarify=true` to ask [clarifying questions](clarify.md) instead of refusing) |
| GET | `/v1/intents` | key | List intents created with the caller's key (`?owner=key_…`: an agent or publishable key below it) |
| GET | `/v1/intents/{id}` | public | Read an intent |
| POST | `/v1/intents/{id}/steps/{stepId}/prepare` | public | Build wallet-ready transactions for a ready step (optional body `{ "acknowledgedPreview": "sha256:…" }`; `?journey=true` adds the journey at signing time) |
| POST | `/v1/intents/{id}/steps/{stepId}/submit` | public | Submit transaction hashes / signatures for verification |
| POST | `/v1/intents/{id}/refresh` | public | Re-read settlement state now |
| POST | `/v1/intents/{id}/cancel` | public | Cancel an intent with no submitted steps |
| GET | `/v1/intents/{id}/events` | public | Server-Sent Events stream of intent events |
| GET | `/v1/intents/{id}/journey` | public | Where the money is after every step and what follows ([journey.md](journey.md)); 30 per minute per intent |
| POST | `/v1/intents/{id}/stop` | public | End the intent at its current stop (skips what has not started; `409 INTENT_IN_FLIGHT` while a step is moving) |
| POST | `/v1/intents/{id}/preview` | public | Recompute the [asset-change preview](preview.md) (`?quotes=refresh` re-quotes ready steps); 6 per minute per intent |
| GET | `/v1/intents/{id}/preview` | public | The last preview computed for the intent (30 minutes) |
| GET | `/v1/intents/{id}/receipt` | public | The intent's latest [receipt](receipts.md) with every disclosure (`?sequence=`); `202` with `Retry-After` while finality is pending |
| GET | `/v1/intents/{id}/receipts` | public | Every receipt sequence of the intent |
| POST | `/v1/intents/{id}/receipt/shares` | public | Share a receipt: encrypted groups, link (with its key) returned once |
| GET | `/v1/intents/{id}/receipt/shares` | public | Active shares (no keys) |
| DELETE | `/v1/intents/{id}/receipt/shares/{shareId}` | public | Revoke a share |
| DELETE | `/v1/intents/{id}/receipt/disclosures` | public | Withdraw stored disclosures and every share |
| GET | `/v1/receipts/keys` | public | Receipt signing keys and EAS attesters |
| GET | `/v1/receipts/log` | public | Transparency log batches (`?limit=`, `?unanchored=true`) |
| GET | `/v1/receipts/log/inclusion?digest=` | public | Inclusion proof of a receipt digest |
| GET | `/v1/receipts/log/{seq}` | public | One batch (`?leaves=true&offset=&limit=` up to 1,000 leaves) |
| POST | `/v1/receipts/log/{seq}/anchor` | operator | Report the Base transaction that timestamped a batch (checked on-chain) |
| GET | `/v1/receipts/{receiptId}` | public | A shared receipt's signed payload (404 unless shared) |
| GET | `/v1/receipts/{receiptId}/status` | public | Whether a shared receipt was superseded |
| GET | `/v1/receipts/{receiptId}/shares/{shareId}` | public | A share's encrypted disclosures |
| POST | `/v1/webhooks` | key | Register a webhook (secret returned once) |
| GET | `/v1/webhooks` | key | List webhooks |
| DELETE | `/v1/webhooks/{id}` | key | Delete a webhook and its delivery log |
| POST | `/v1/webhooks/{id}/test` | key | Send a signed `webhook.test` event now |
| GET | `/v1/webhooks/{id}/deliveries` | key | Delivery log (`?limit=1..100`) |
| GET | `/v1/events` | key | Server-Sent Events stream of the key's events, routed like its webhooks (`?scope=self` or `subtree`, `?types=`) |
| POST | `/v1/keys` | public | Issue a developer key (with a developer key: a sibling in the same project) |
| GET | `/v1/keys` | key | List the keys of the caller's project |
| POST | `/v1/keys/{id}/rotate` | key | New secret for a key, same id, with a grace window |
| DELETE | `/v1/keys/{id}` | key | Revoke a key and every agent key below it |
| PATCH | `/v1/keys/{id}` | key | Change a key's expiry (`{ "expiresAt" }`; shorten at once) |
| POST | `/v1/keys/{id}/children` | key | Issue an agent key (`kl_agt_…`) under a key, with its [rule book](policies.md) |
| GET | `/v1/keys/{id}/policy` | key | A key's rule book (active, pending) and its effective chain |
| PUT | `/v1/keys/{id}/policy` | key | Write a key's rule book (tighten now, loosen after the delay; `If-Match`) |
| DELETE | `/v1/keys/{id}/policy` | key | Remove a key's rule book (a loosening) |
| DELETE | `/v1/keys/{id}/policy/pending` | key | Cancel a pending amendment |
| GET | `/v1/keys/{id}/policy/versions` | key | Every version of a key's rule book |
| GET | `/v1/projects/current/policy` | key | The project rule book |
| PUT | `/v1/projects/current/policy` | key | Write the project rule book |
| DELETE | `/v1/projects/current/policy` | key | Remove the project rule book |
| DELETE | `/v1/projects/current/policy/pending` | key | Cancel the project's pending amendment |
| POST | `/v1/policy/validate` | public | Validate a rule book and compare it with another |
| POST | `/v1/policy/evaluate` | key | Simulate a request against a key's chain (30 per minute per key) |
| GET | `/v1/policy/decisions` | key | The hash-chained decision log of the caller's subtree |
| GET | `/v1/policy/decisions/{id}` | key | One decision |
| GET | `/v1/policy/spend` | key | Spend windows and what remains at every level of a key's chain |
| GET | `/v1/policy/approvals` | key | Approvals requested by (or waiting for) the caller |
| GET | `/v1/policy/approvals/{id}` | public | Read an approval (the id is the capability) |
| POST | `/v1/policy/approvals/{id}/approve` | public | Approve with a project key or a listed wallet's signature |
| POST | `/v1/policy/approvals/{id}/reject` | public | Reject (the intent is cancelled) |
| GET | `/v1/usage` | key | Requests, status classes, rate-limit window, intents, custom contract activity and receipts of the caller's key (`?scope=subtree` adds every key of the subtree) |
| POST | `/v1/links` | key | Publish an [intent link](links.md) |
| GET | `/v1/links` | key | The caller's links (`?status=&limit=`) |
| GET | `/v1/links/{id}` | public | A link (owner view for its managers, public view otherwise) |
| PATCH | `/v1/links/{id}` | key | Tighten, pause or resume a link |
| DELETE | `/v1/links/{id}` | key | Withdraw a link |
| POST | `/v1/links/{id}/quote` | public | Quote a funding choice (nothing stored) |
| POST | `/v1/links/{id}/intents` | public | Create the visitor's intent (owned by the link's key) |
| GET | `/v1/links/{id}/stats` | key | Day-level counters (`?window=7d|30d|90d`) |
| GET | `/v1/links/{id}/card.png` | public | Share card PNG (`?variant=square`) |
| GET | `/v1/links/{id}/page` | public | Page shell with per-link meta (served at `kletiaai.xyz/go/{id}`) |
| POST | `/v1/links/{id}/report` | public | Report a link |
| POST | `/v1/links/{id}/suspend` | operator | Suspend a link |
| POST | `/v1/links/{id}/blink-approval` | operator | Approve or revoke a link's blink |
| GET | `/v1/blinks/{id}` | public | Solana Action metadata of a link |
| POST | `/v1/blinks/{id}` | public | The visitor's first unsigned Solana transaction |
| POST | `/v1/blinks/{id}/next` | public | Record a signed step and chain the next one |
| POST | `/v1/contracts` | key | Register a custom EVM contract or Solana Actions origin ([contracts.md](contracts.md)) |
| GET | `/v1/contracts` | key | The key's registrations and its project's visible ones (`?network=&vm=&status=`) |
| GET | `/v1/contracts/inspect` | key | What registering an address (`?network=&address=`) or programs (`?network=solana&programs=`) would pin and allow |
| GET | `/v1/contracts/{id}` | key | One registration |
| PATCH | `/v1/contracts/{id}` | key | Update (security-relevant changes become a new revision) |
| DELETE | `/v1/contracts/{id}` | key | Soft delete |
| POST | `/v1/contracts/{id}/test` | key | Dry-run one entry for an account (simulation and review) |
| POST | `/v1/contracts/{id}/reverify` | key | Re-pin and re-check after an intended upgrade |
| POST | `/v1/contracts/{id}/suspend` | operator | Suspend any registration |
| POST | `/v1/sessions` | key, publishable | Create a session the embed turns into an intent for a visitor (a publishable key sends only `{ flow, hostOrigin }`) |
| GET | `/v1/sessions/{id}` | public | Session view for the embed |
| POST | `/v1/sessions/{id}/intents` | public | Turn a session into an intent for the visitor's accounts |
| GET | `/v1/threads` | key | The key's Kletia-held [clarify threads](clarify.md#threads) (`?status=&limit=&cursor=`) |
| GET | `/v1/threads/{id}` | key | One thread: its blob, context, last response and intents |
| DELETE | `/v1/threads/{id}` | key | Delete a thread at once |
| GET | `/v1/projects/current` | key | The project's settings, version, hash and domain proof ([projects.md](projects.md)) |
| PATCH | `/v1/projects/current` | key | Merge-patch the settings (`If-Match`; project key, current secret) |
| POST | `/v1/projects/current/domain/verify` | key | Check `https://<brand.website>/.well-known/kletia.json` now |
| POST | `/v1/projects/current/publishable-keys` | key | Issue a publishable key (`kl_pub_…`, shown once, at most 5 active) |
| PUT | `/v1/projects/current/logo` | key | Upload the brand logo (raw PNG or WebP, at most 64 KB) |
| DELETE | `/v1/projects/current/logo` | key | Remove the logo |
| GET | `/v1/projects/{projectId}/logo/{sha256}.{png\|webp}` | public | The logo, immutable, while the domain is verified |
| GET | `/v1/publishable/profile` | publishable | What the publishable key reveals: brand, origins, lane, defaults, flows |
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

`GET /v1/intents` accepts `?limit=1..100` (default 20) and `?owner=key_…`: the
intents of an agent or publishable key below the caller (project keys: any
such key of the project; agent keys: their own descendants; `404
KEY_NOT_FOUND` otherwise).

#### Clarifying questions: `?clarify=true`

`POST /v1/intents?clarify=true` takes an `IntentTurnRequest` (the request
context plus at most one of `text`, `answer`, `assumption`, and at most one
of `thread`, `threadId`) and asks instead of refusing an incomplete sentence.
Without the flag (or with `clarify=false`) the endpoint is the strict planner,
byte for byte as before. Full reference: [clarify.md](clarify.md).

| Outcome | Status | Body |
|---|---|---|
| `needs_input` | 200 | `{ status, turn, questions, assumptions, draft, thread }` |
| `planned`, stored | 201 (200 with `Idempotent-Replayed: true` when its clientReference already planned an intent) | `{ status, turn, intent, preview?, journey?, assumptions, sentence, thread }` |
| `planned`, dry run | 200 | as above, nothing stored |
| `cancelled` | 200 | `{ status: "cancelled", turn: "control", thread }` |
| refusal | the code's status | the error envelope; the thread is unchanged |

Threads are client-held by default: each response returns the whole thread
(`kletia.thread/v1`, at most 16 KB) and the client sends it back. With an API
key, `remember: true` on a first turn keeps the thread at Kletia: responses
carry a `ThreadRef` (`id`, `rev`, `status`, `expiresAt`), later turns send
`threadId` and may leave out the context, and `expectedRev` (or `If-Match:
"<rev>"`) refuses a thread that moved on (`409 THREAD_CONFLICT`). Kletia-held
threads expire 30 minutes after the last turn and 24 hours after creation,
close after 50 turns (`409 THREAD_CLOSED`), belong to their key (`404
THREAD_NOT_FOUND` for any other) and are capped at 1,000 open per key (`429
RATE_LIMITED`). `GET /v1/threads`, `GET /v1/threads/{id}` and `DELETE
/v1/threads/{id}` (204) read and delete them. The stored intent's
clientReference is `<clientReference>:r<rev>` (default
`thread:<threadId>:r<rev>`), so a retried commit returns the same intent.

#### Where the money starts: `sourceNetwork`

`sourceNetwork` names the network the funds start on: a network key, or
`"auto"`. Without it nothing changes. With it, the first action spends funds
that are on that network, and the response says what the planner did in
`intent.interpretation.departure`:

```json
{ "network": "base", "chosen": "request", "bridged": true, "reason": "Base holds 120.40 USDC; Solana 2.00" }
```

`chosen` is `text` (the sentence named the network), `request`
(`sourceNetwork`), `auto` (picked by balance) or `inferred`; `bridged` is true
when the planner put a bridge in front of the first action. A network key also
serves as `defaultNetwork` when that is absent.

| Case | Result |
|---|---|
| The first action already runs on the departure | unchanged; `chosen: "request"` |
| The sentence names the first action's network and it differs | the sentence wins; `chosen: "text"`, with a warning that the departure was not used |
| The first action is a swap, deposit or stake on another network and its input can move there | a bridge from the departure (same asset, the stated amount) is added first and the action spends its output; bridge and swap may merge into one cross-network swap; `bridged: true` |
| The first action is a transfer on another network | `422 SOURCE_UNREACHABLE` (a bridge would deliver less than the stated amount; send it as two steps) |
| The first action is a withdraw | unchanged, with a warning (a position starts where it is) |
| Departure and action on different capital lanes (testnet and mainnet) | `422 SOURCE_UNREACHABLE` |
| The input cannot move to the departure (SOL from Base, ETH from Solana) | `422 SOURCE_UNREACHABLE` |
| `auto`, and the sentence names the network | `chosen: "text"`, no balance reads |
| `auto` with preview (demo) accounts | no balance reads; as if absent, except a bridge without a source is `422 SOURCE_REQUIRED` |
| `auto`, a bridge without a source | the input's balance is read on each same-lane network that lists it (at most 5 reads); the largest balance that covers the amount wins; none covers it: `422 SOURCE_REQUIRED` with `details.candidates` |
| `auto`, the first action's own network covers the input | unchanged; `chosen: "auto"`, the reason names the balance |
| `auto`, it does not but another network does | as the fixed case from that network; `chosen: "auto"`, `bridged: true` |
| `auto`, no network covers it | unchanged; `chosen: "auto"`, reason "No network holds enough USDC"; the balance check reports the shortfall as usual |

Inputs that can move (v1): USDC between every network that lists canonical
USDC, and native ETH between Base, Arbitrum One, Ethereum and OP Mainnet.
Bridges never run between testnets, so a testnet departure only works when the
first action is already on it.

Example: swap on Solana with the money on Base.

```json
{ "text": "swap 10 USDC to SOL", "sourceNetwork": "base", "accounts": ["eip155:8453:0x1111111111111111111111111111111111111111", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] }
```

The plan bridges 10 USDC from Base to Solana and swaps its output to SOL
(possibly as one cross-network swap); `departure` is
`{ "network": "base", "chosen": "request", "bridged": true }`.

Example: let Kletia find the funds.

```json
{ "text": "bridge 25 USDC to solana", "sourceNetwork": "auto", "accounts": ["eip155:8453:0x1111111111111111111111111111111111111111", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"] }
```

When no network holds 25 USDC the answer is:

```json
{ "error": { "code": "SOURCE_REQUIRED", "message": "No network holds 25 USDC for this bridge. Say where the money comes from.", "details": { "asset": "USDC", "amount": "25", "toNetwork": "solana", "candidates": [{ "network": "base", "balance": "3.10", "enough": false }] } }, "requestId": "…" }
```

Custom contract steps: `{ "kind": "call", "network": "arbitrum", "contract": "ct_…" | "<alias>", "entry": "deposit", "amount": "100" }`
(`kind: "action"` on Solana networks) call a registration the request's API
key may use; text plans with the key's aliases too ("deposit 100 USDC into
acme vault"). Such steps carry `step.call` (the registration snapshot and its
`review`). See [Custom contracts](#custom-contracts).

#### The journey: `?journey=true`

`POST /v1/intents?journey=true` (dry runs too) answers `{ intent, preview,
journey }`: the journey implies the plan-stage preview and is built on it
(`journey.basis.previewDigest` equals `preview.digest`). It says where the
money is after every step, who holds it, how much arrives at least, the
refund path of each bridge, and consequences by severity (`block`, `act`,
`warn`, `info`) with options such as adding gas on arrival. A `block` must be
answered before the next signature. `journeyReads=none` skips account reads
(demo or placeholder accounts). A journey that cannot be built is `null`,
never a failed create. Full reference: [journey.md](journey.md).

| Route | Change |
|---|---|
| `POST /v1/intents?journey=true` | `{ intent, preview, journey }`; `journeyReads=live` (default) or `none` |
| `POST …/steps/{stepId}/prepare?journey=true` | adds `journey`, built on the prepare-stage preview |
| `GET /v1/intents/{id}/journey` | `{ journey }`; 30 per intent per minute (on top of the tier), `refresh=true` once per 10 s per intent, `reads=none`; 404 `INTENT_NOT_FOUND` |
| `POST /v1/intents/{id}/stop` | `{ intent, journey }`; `409 INTENT_IN_FLIGHT` (retryable, `Retry-After`); idempotent, honours `Idempotency-Key` |

There is no `?journey` flag on `GET /v1/intents/{id}` or `POST …/preview`:
fetch the journey with the plan and when a step changes (events or
webhooks), not on a timer.

`IntentStep` carries three optional journey fields: `funding` (`{ from,
portionBps, gasReserve? }`: which step's output it spends, the share, and gas
kept back for fees), `gasTopup` (gas delivered with a cross-network fill
when the request asked for it) and `observedCredit` (on a failed leg, what
the destination credited below the floor: that amount is in the recipient's
wallet). `IntentConstraints.gasOnArrival` (`{ "base": "0.50" }`, USD "0.05"
to "5.00" per EVM network) opts into gas delivered with the first leg
arriving there; a route no venue can serve that way is `422
GAS_TOPUP_UNAVAILABLE`.

#### Ending an intent: `POST /v1/intents/{id}/stop`

Stopping skips every step not started (and failed ones); the money stays
where the journey says and nothing moves. Nothing started: `cancelled` (as
with `POST …/cancel`). A step settled: `partially_completed`, the skipped
steps carry a note, and the receipt is issued as usual. While a step is
`submitted`, `confirmed`, `settling` or `indeterminate`, or holds a prepared
payload that can still be signed, the stop answers `409 INTENT_IN_FLIGHT`
with `Retry-After` (the payload's remaining seconds, else 30). Repeating a
stop returns the same intent.

### Portfolios

`GET /v1/portfolio/{accountId}` reads one CAIP-10 account: the gas asset and
every canonical asset of its network (EVM balances in one Multicall3 read
where deployed). Every holding carries `priceSource` (`usd-par` for USD
stablecoins, `jupiter`, `chainlink` or `pyth`; `unpriced` when no price is
known, `testnet` for testnet assets) and `pricedAt`; gas assets are priced
with the same advisory prices as fee estimates, and an unknown price is
`usd: null`, never 0. `?positions=true` adds `positions` (lending, savings
and vault positions valued in the underlying: Aave and SparkLend aTokens,
Compound V3, ERC-4626 shares, Moonwell, Jupiter Lend) and
`positionsUnavailable` (venues that could not be read).

`GET /v1/portfolio?accounts=<a>,<b>,…` reads up to 12 accounts in one
request:

```
GET /v1/portfolio?accounts=eip155:8453:0xd8dA…6045,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzD…AWWM
200 { "portfolios": [Portfolio, …], "failures": [{ "account", "code", "message" }], "observedAt": "…" }
```

- Request order is kept and duplicates are removed (EVM addresses ignoring
  case); a missing list, more than 12 accounts or an invalid id is `400
  INVALID_REQUEST` (issue path `accounts[i]`).
- Accounts are read 4 at a time with 8 s each; an account that cannot be read
  is a `failures` entry and the request still answers 200. Each account is
  cached for 15 s.
- A request costs one request of the tier limit plus one unit per account of
  a per-IP budget of 60 account reads per minute (`429 RATE_LIMITED` with
  `Retry-After` after that).

A live request for the six production accounts of one public address
(Ethereum, Base, Arbitrum One, OP Mainnet, Polygon PoS, Solana) answered six
portfolios in 1.5 s with every gas asset priced.

### Protocols

`GET /v1/protocols` lists the registry with `executable` (an execution
adapter is live), `surface` and `routedVia`:

| Field | Values |
|---|---|
| `surface` | `platform`: Platform API v1 plans and executes it (and the SDK, widget, embed and CLI); `console`: only the Kletia console's network engines and tools (Kletia Intent Router V2, Basenames, Arc native, Circle App Kit); `service`: a separate Kletia service (x402 payments). |
| `routedVia` | Protocols every transaction also uses: Raydium, Orca and Meteora run through the Jupiter program (`["jupiter"]`); `[]` otherwise. `constraints.avoidProtocols` and Rule Book protocol rules apply to these dependencies too. |

`GET /v1/networks` lists, per network, the actions the engine can execute;
with the built-in adapters every production network lists `swap`.

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
2. `POST …/steps/{stepId}/prepare` → `{ "payload": StepExecutionPayload, "intent": IntentGraph, "preview": IntentPreview }`.
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

Every payload is simulated before it is handed out: `payload.preview` is the
effect of exactly these transactions (`payload.preview.quoteBinding` equals
`payload.quoteBinding`) and `preview` is the whole intent's fare breakdown. A
payload whose simulated effect differs from its step is refused. Send the
digest of the preview the user approved as `{ "acknowledgedPreview": "sha256:…" }`:
a materially worse payload answers `409 PREVIEW_CHANGED` with `error.preview`
(the fresh preview) and `error.changes`; an unknown digest is not an error
(`Kletia-Preview-Ack: unknown`, also `previewAck` in the body). See
[preview.md](preview.md).

For custom contract steps (`call` / `action`), `payload.review` is the review
of exactly these transactions (simulated asset changes, approvals,
provenance, "Not audited by Kletia"): show it to the user before handing the
transactions to the wallet.

A payload expires at `payload.expiresAt`, a number of **Unix seconds** (not an
ISO string like the other timestamps); prepare again to re-quote. `payload.quoteBinding` is a SHA-256 over each transaction's chain, sender, target, calldata and value (EVM) or fee payer and program (Solana); the landed transactions must match a prepared payload. Re-preparing is allowed, and an older payload that lands later still verifies. For Solana steps, `step.prepared.transactions[].to` holds the invoked program id.

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

Types: `intent.created`, `intent.status_changed`, `intent.step_updated`,
`intent.receipt_issued` (a [receipt](receipts.md) was issued, after every
reference finalized; ids and digest only), the
contract registration events `contract.registered`, `contract.activated`,
`contract.suspended` and `contract.reactivated` (webhooks only, routed to the
registration's own key; see [contracts.md](contracts.md#webhooks)), the
[link](links.md#webhooks) events `link.created`, `link.activated`,
`link.updated`, `link.paused`, `link.suspended`, `link.exhausted`,
`link.expired` and `link.deleted` (routed to the link's key), the
[Rule Book](policies.md#webhooks) events `policy.violation`,
`policy.approval_requested`, `policy.approval_decided`,
`policy.amendment_pending`, `policy.amended` and `policy.spend_threshold`
and the key events `key.created` and `key.revoked` (routed to the subject
key), and `webhook.test` (only from `POST /v1/webhooks/{id}/test`). A webhook
created without `events` subscribes to every type that exists at creation
time.

`POST /v1/webhooks` takes `"scope": "self" | "subtree"` (default `self`). A
`subtree` webhook also receives the events of every agent key below its key
(intents, receipts, links, Rule Book and key events), and on a project key
the project-wide Rule Book events. Agent keys need `permissions.webhooks` to
create, delete or test webhooks.

The SSE stream starts with `retry: 3000`, replays buffered events after `Last-Event-ID` (or `?since=<event id>`), then streams live events with a heartbeat comment every 15 s. Each API key and each client IP may hold 10 open streams (a stream opened with a key counts against both); a stream closes after 30 minutes. Replays and webhook retries can deliver an event more than once; de-duplicate by `id`.

#### The key's event stream: `GET /v1/events`

`GET /v1/events` (API key) streams every event the key's webhooks would
receive, routed by the same rules: intent and receipt events of the key's
intents, its contract registration and link events, and its Rule Book and
key events. Each frame is `id`, `event` (the type) and `data`: the webhook
envelope `{ id, type, at, data }`.

| Parameter | Meaning |
|---|---|
| `scope` | `self` (default): the key's own events. `subtree`: also the events of its descendant agent keys, and on a project key the project-wide Rule Book events (like a `scope: "subtree"` webhook). |
| `types` | Comma-separated event types, e.g. `intent.status_changed,link.created` (default: every type). |
| `Last-Event-ID` / `since` | Replays the matching events after that id from the API process's buffer (500 events, 10 minutes); an id no longer buffered replays the whole buffer. Without it the stream starts with live events. |

At most 2 streams per key (`429 TOO_MANY_STREAMS`, on top of the per-client
SSE limit); a stream lasts at most 30 minutes. Every heartbeat re-checks the
key and its ancestors: a revoked or expired key's stream ends. The buffer is
per process, like the intent streams: reconcile with the current state after
a reconnect. It suits local development (no public HTTPS endpoint needed)
and servers that prefer a stream to webhooks.

SSE buffers and live subscriptions belong to one API process. A restart, or a
reconnection that reaches another replica, can leave a gap: `Last-Event-ID` is
not a durable cursor. Re-fetch `GET /v1/intents/{id}` when you reconnect, and
periodically while you follow an active intent; the event stream alone cannot
reconstruct every transition across replicas.

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
Pause counters belong to the API process that makes the attempts (a restart
resets them); with Postgres the in-flight limits are shared by every process.

Every attempt, retries included, re-reads the webhook and the live state of
its key and every ancestor key: a deleted webhook, or a revoked or expired key
or ancestor, receives no further attempt (the delivery is logged as dropped).
When that state, the webhook or the intent's owner cannot be read (storage
failing), the delivery waits without spending an attempt, 1 s doubling to
60 s; after 120 such deferrals (about two hours) it is dropped as
`deferred_too_long`.

With Postgres (`KLETIA_DATABASE_URL`), webhook deliveries use a durable queue.
Each routed delivery is stored before its first HTTP attempt, its event body
encrypted with the platform secret, so retries survive API restarts. Workers
claim bounded batches with 30-second fenced leases; an interrupted attempt is
picked up again once its lease expires. Attempt results and retry schedules
are recorded together, and a worker polls every 500 ms while there is work
and backs off to every 5 s when idle. The queue deduplicates `(webhook id,
event id)`, but a receiver must still deduplicate by event id: a crash after
a successful HTTP response and before it is recorded repeats that delivery.
Delivered, exhausted and dropped rows discard the body at once and keep their
deduplication identifiers for 7 days. A queued body that no longer opens (the
platform secret changed) is never sent: it is dropped as `payload_unreadable`
and the rest of the queue keeps flowing. Without Postgres the queues are
in memory and transient.

The durable queue starts when an event is routed to a webhook. A state change
and its routing are not one transaction, so a process crash before the first
queue write can still lose that notification; queue bounds and exhausted
retries can also prevent a delivery. Delivery is bounded at-least-once for
queued work, not an exactly-once or complete event history: reconcile with the
current intent state (`GET /v1/intents/{id}`).

Webhook secrets are encrypted at rest with `KLETIA_PLATFORM_SECRET` (at least
32 characters). It is required whenever `KLETIA_DATABASE_URL` is set; with the
in-memory store a development key is used and `GET /v1/health` reports
`webhooks.sealing: "development_fallback"`. `webhooks.dispatcher` reports the
answering API process's activity and where deliveries wait (`storage`:
`memory` or `postgres`); with Postgres, `queued` and `scheduledRetries` are the
last snapshot of the shared queue and the other counters describe the
answering process. Changing `KLETIA_PLATFORM_SECRET` makes every registered
webhook secret and every queued body unreadable: re-create the webhooks.

### Model-assisted reading consent

`POST /v1/reading-consent` `{ scope: "once" | "session" | "confirm", wallet, text?, threadId? }`
returns `{ token, expiresAt, scope }` for browser callers only (the Kletia
desk, or a publishable key of a project with `modelReading: "enabled"` from an
allowed origin). Server keys get `403 CONFIRM_AUTHORITY_REQUIRED`. Send the
token as `consent` on the clarify turn ([clarify.md](clarify.md#model-assisted-reading-opt-in)).

Route explanations: planned intents may carry `interpretation.routes` (per
leg: shape, carrier, venues, score with `minimumKind` "onchain" (guaranteed
minimum) or "claimed" (quoted minimum), `reason`, `compared`, `alternatives`)
and `interpretation.providersContacted` (`{ provider, sawAccount }`).

## Idempotency

Keyed `POST` requests that create or change state accept an
`Idempotency-Key` header (draft-ietf-httpapi-idempotency-key-header):
`POST /v1/intents`, `/intents/{id}/cancel`, `/intents/{id}/steps/{stepId}/submit`,
`POST /v1/webhooks`, `POST /v1/keys`, `/keys/{id}/rotate`,
`POST /v1/keys/{id}/children`, `PUT /v1/keys/{id}/policy`,
`PUT /v1/projects/current/policy`, `POST /v1/contracts`,
`PATCH /v1/contracts/{id}`, `POST /v1/contracts/{id}/reverify`,
`POST /v1/sessions`, `POST /v1/links` and `PATCH /v1/links/{id}`.

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
  (quotes, refresh, webhook tests, contract tests, session intents, MCP) are
  safe to repeat and ignore it (a session's use count already makes
  `POST /v1/sessions/{id}/intents` single-use).
- Clarify turns (`POST /v1/intents?clarify=true`) that create or change a
  Kletia-held thread (`remember: true` or `threadId`) honour the header even
  as dry runs: a retry replays the stored turn instead of running a second
  one. Client-held clarify dry runs ignore it, like other dry runs. A turn
  whose text or answer carries a secret is refused before the key is
  reserved, so nothing is stored for it.
- Retryable Rule Book refusals (`POLICY_SPEND_LIMIT`, `POLICY_SCHEDULE_CLOSED`,
  `POLICY_PRICE_UNAVAILABLE`, `POLICY_APPROVAL_REQUIRED`) are never stored, so
  a retry is evaluated again. After loosening a rule book, retry a refused
  request with a new key.
- Responses that carry a secret (API keys, agent keys, webhook signing secrets) are stored
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
use one key per environment. `POST /v1/keys` with `"sandbox": true` issues a
[sandbox key](#sandbox-keys) into the same project.

- `GET /v1/keys` lists the project's keys (newest first) with `last4`,
  `createdAt`, `lastUsedAt` (updated at most once a minute), `rotatedAt`,
  `previousExpiresAt`, `revokedAt`, `lane` (`testnet`, `production` or `any`:
  what the key's rule books allow) and `current` (the calling key). Secrets
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
- **Agent keys.** `POST /v1/keys/{id}/children` issues a `kl_agt_…` key under
  a key, with its own rule book (or none: an observer that only plans and
  dry-runs). Agent keys sit at most 2 levels below a project key (100 active
  per project), always expire (never after their parent), authenticate only
  while every ancestor is active, cannot issue project keys, write rule books
  or approve, and need permissions for webhooks, contracts, sessions, links
  and stored intents. Revoking a key revokes its subtree. `GET /v1/keys`
  reports `kind`, `parentId`, `depth`, `expiresAt`, `policyVersion` and
  `descendants`; agent keys see their own subtree. `PATCH /v1/keys/{id}`
  `{ "expiresAt": "…" }` shortens an expiry at once; extending is refused
  while the key's rule book has an amendment delay. See
  [policies.md](policies.md#agent-keys).

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
  `redirect`, `forbidden_address`, `queue_full`, `payload_unreadable`,
  `deferred_too_long`); payloads and error text are never stored. Dropped
  before sending: `queue_full` (a queue bound was hit), `payload_unreadable`
  (a queued body no longer opens, for example after the platform secret
  changed) and `deferred_too_long` (the delivery could not be attempted for
  about two hours because key, webhook or intent storage kept failing; its
  `attempt` is unchanged). A delivery dropped for a deleted webhook or a
  revoked or expired key has no class. Logs are kept 7 days (at most 1000
  entries per webhook; 100 with in-memory storage) and deleted with the
  webhook.

## Usage

`GET /v1/usage?window=24h|7d` (key) reports the caller's key:

```json
{
  "keyId": "key_…", "tier": "developer", "window": "24h", "since": "…", "generatedAt": "…",
  "rateLimit": { "limit": 300, "remaining": 287, "resetAt": "…", "windowSeconds": 60 },
  "totals": { "requests": 1342, "byStatusClass": { "2xx": 1301, "4xx": 41 } },
  "byRoute": [{ "route": "POST /intents", "requests": 120, "byStatusClass": { "2xx": 118, "4xx": 2 } }],
  "series": [{ "hour": "…", "requests": 51 }],
  "intents": { "created": 120, "byStatus": { "completed": 97, "planned": 23 } },
  "contracts": { "registered": 2, "suspended": 0, "preparedToday": 14, "notionalTodayUsd": 4210.5 },
  "receipts": { "issued": 95, "pending": 2, "sharesActive": 3 }
}
```

Requests are counted per hour, route template and status class and written
every 30 seconds (per request on serverless hosts). `rateLimit` is the current
window on the answering instance. `contracts` counts the key's registrations
and, for the current UTC day, its prepared custom contract steps and their
priced notional (the daily cap's counter). `receipts` counts the receipts of
the key's intents issued in the window, its intents waiting for one, and the
active shares of their receipts.

`?scope=subtree` adds `subtree: { keys, truncated }`: for every key of the
caller's subtree (a project key sees the whole project, newest 100 keys),
`{ keyId, name, kind, parentId, revokedAt, requests, intents: { created, byStatus }, notional: { dayUsd, weekUsd } }`,
the notional being the rolling USD exposure counted against
[spend caps](policies.md#spend-caps-and-the-exposure-ledger).

## Rule Book

Rule books bound what Kletia plans and prepares for a key: networks, assets,
protocols, contracts, recipients, per-step, per-intent, daily and weekly USD
caps, a timetable and approvals, checked against the project, every ancestor
key and the key itself. Refusals carry `error.policy` (every violated rule,
the refusing key, `retryAt`, the approval to share); stored intents carry
`intent.policy` and prepared payloads `payload.policy`. The full guide is
[policies.md](policies.md).

## Intent links

Public pages (`kletiaai.xyz/go/lk_…`) that do one fixed thing in the
visitor's own wallet, funded from the visitor's choice of networks and
assets: definition rules, the tighten-only promise, uses, the page and share
card, blinks and counters are in [links.md](links.md).

## Custom contracts

Integrators register their own EVM contracts (ABI actions) and Solana Actions
endpoints, and intents created with their key can call them. The full guide,
with the definition reference, the safety model and sessions, is
[contracts.md](contracts.md). In short:

- `POST /v1/contracts` validates the definition (the same rules as
  `validateContractDefinition` in `@kletia/core`: no approvals, transfers,
  upgrades, multicall or arbitrary calldata; beneficiary arguments bound to
  the user), pins the contract's code identity (proxy implementations
  included) or the Solana programs' deployments, and records Sourcify /
  OtterSec verification. Mainnet registrations activate after a delay
  (default 15 minutes) and announce themselves with `contract.registered`.
- Only intents created with the registration's key (or its project, for
  `visibility: "project"`) can use it; every other caller gets
  `CONTRACT_UNKNOWN`.
- Every call or action step is simulated at plan and again at prepare against
  the user's real state, carries a `review`, re-reads the pins at prepare and
  at the receipt block, and is verified from the declared events and the
  user's asset changes. Any anomaly suspends the registration.
- Sessions (`POST /v1/sessions`) let the embed run your fixed actions for a
  visitor's wallet; see [contracts.md](contracts.md#sessions) and
  [embed.md](embed.md).
- MCP agents can list, read and test-simulate registrations and plan intents
  that use them; signing links refuse them ([mcp.md](mcp.md)).

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
| `call` | Every EVM network | A registered custom contract action ([contracts.md](contracts.md)) |
| `action` | Solana, Solana Devnet | A registered Solana Action ([contracts.md](contracts.md)) |

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
