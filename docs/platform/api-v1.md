# Kletia Platform API v1

Kletia Platform API v1 is the integration surface for teams that want
cross-network intents in their own product. The first-party Kletia app uses
this same API for Solana and cross-network flows.

- Base URL: `https://api.kletiaai.xyz/v1` (local: `http://localhost:3001/v1`)
- Spec: `GET /v1/openapi.json` (OpenAPI 3.1)
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
| Operator | Key configured in `KLETIA_OPERATOR_API_KEYS` | 1200 requests/min per key | Everything above, plus suspending any contract registration |

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
| 403 | A rotated-out secret managing keys or registering contracts (`KEY_SECRET_ROTATED`), a refused browser origin on `/v1/mcp` (`MCP_ORIGIN_FORBIDDEN`), a session used from another site (`SESSION_ORIGIN_FORBIDDEN`) |
| 404 | Unknown intent, step, webhook, key, contract registration (`CONTRACT_NOT_FOUND`, also for other keys' private ones), session or path; no kept preview (`PREVIEW_NOT_FOUND`); unknown or unshared receipt, share or log batch (`RECEIPT_NOT_FOUND`, `RECEIPT_SHARE_NOT_FOUND`, `RECEIPT_LOG_NOT_FOUND`) |
| 405 | Wrong method (with an `Allow` header) |
| 409 | State conflict (`QUOTE_MOVED`, `STEP_NOT_READY`, cancel after submission, duplicate webhook, `KEY_LIMIT_REACHED`, `KEY_NOT_MANAGEABLE`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `RECIPIENT_NAME_CHANGED`, `CONTRACT_EXISTS`, `CONTRACT_LIMIT_REACHED`, `CONTRACT_PENDING`, `CONTRACT_SUSPENDED`, `CONTRACT_CHANGED`, `CONTRACT_REVISION_CHANGED`, `SESSION_USED`, `PREVIEW_CHANGED`, `RECEIPT_NOT_READY`, `RECEIPT_NOT_APPLICABLE`, `RECEIPT_SHARE_LIMIT`, `RECEIPT_ANCHOR_EXISTS`) |
| 410 | Expired (`INTENT_EXPIRED`, `DEADLINE_PASSED`, `SESSION_EXPIRED`, `RECEIPT_SHARE_EXPIRED`, `RECEIPT_DISCLOSURES_WITHDRAWN`) |
| 413 / 415 | Body over 64 KB / non-JSON body |
| 422 | Understood but not executable (`INTENT_UNSUPPORTED`, `INSUFFICIENT_BALANCE`, `SELF_TRANSFER`, `FEE_LIMIT_EXCEEDED`, `CAPITAL_LANE_MIXED`, `ROUTE_UNSUPPORTED`, `ROUTE_TOO_SLOW`, `POSITION_EMPTY`, `VENUE_UNVERIFIED`, `VENUE_ILLIQUID`, `RECIPIENT_NAME_UNRESOLVED`, `WEBHOOK_URL_FORBIDDEN`, `IDEMPOTENCY_KEY_REUSED`, the custom contract refusals (`CONTRACT_UNKNOWN`, `CONTRACT_DENIED`, `CONTRACT_FUNCTION_FORBIDDEN`, `CONTRACT_NOT_DEPLOYED`, `SIMULATION_ASSET_CHANGE_REFUSED`, `ACTION_TRANSACTION_REJECTED`, …), and the reference rejections `REFERENCE_MISMATCH`, `REFERENCE_WRONG_SENDER`, `REFERENCE_WRONG_CHAIN`, `REFERENCE_ALREADY_USED`, `REFERENCE_STALE`) |
| 429 | Rate limited (with `Retry-After`) |
| 502 / 503 | Upstream provider unavailable (`ACTION_ENDPOINT_UNAVAILABLE` for an integrator's Solana Action server), or a feature not configured or disabled (`WEBHOOKS_NOT_CONFIGURED`, `CONTRACTS_DISABLED`, `SIMULATION_UNAVAILABLE`, `RECEIPTS_DISABLED`) |

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
| POST | `/v1/intents` | public | Plan an intent into an `IntentGraph` (`?dryRun=true` to skip persistence, `?preview=true` for the [asset-change preview](preview.md)) |
| GET | `/v1/intents` | key | List intents created with the caller's key |
| GET | `/v1/intents/{id}` | public | Read an intent |
| POST | `/v1/intents/{id}/steps/{stepId}/prepare` | public | Build wallet-ready transactions for a ready step (optional body `{ "acknowledgedPreview": "sha256:…" }`) |
| POST | `/v1/intents/{id}/steps/{stepId}/submit` | public | Submit transaction hashes / signatures for verification |
| POST | `/v1/intents/{id}/refresh` | public | Re-read settlement state now |
| POST | `/v1/intents/{id}/cancel` | public | Cancel an intent with no submitted steps |
| GET | `/v1/intents/{id}/events` | public | Server-Sent Events stream of intent events |
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
| POST | `/v1/sessions` | key | Create a session the embed turns into an intent for a visitor |
| GET | `/v1/sessions/{id}` | public | Session view for the embed |
| POST | `/v1/sessions/{id}/intents` | public | Turn a session into an intent for the visitor's accounts |
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

Custom contract steps: `{ "kind": "call", "network": "arbitrum", "contract": "ct_…" | "<alias>", "entry": "deposit", "amount": "100" }`
(`kind: "action"` on Solana networks) call a registration the request's API
key may use; text plans with the key's aliases too ("deposit 100 USDC into
acme vault"). Such steps carry `step.call` (the registration snapshot and its
`review`). See [Custom contracts](#custom-contracts).

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

SSE buffers and live subscriptions belong to one API process. A restart or
connection to another replica can leave a gap; `Last-Event-ID` is not a
durable cursor. Re-fetch `GET /v1/intents/{id}` on reconnect and periodically
while following an active intent. An event stream alone cannot reconstruct
every transition across replicas.

Webhook deliveries are `POST` with header
`Kletia-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
Verify with `verifyWebhookSignature` from `@kletia/core`. Deliveries also carry
`Kletia-Event-Id`, `Kletia-Event-Type`, `Kletia-Webhook-Id` and
`Kletia-Delivery-Attempt`, and retry up to 3 times (1 s, 5 s, 25 s); redirects
are never followed. Webhook URLs must be public HTTPS; private, loopback,
link-local and metadata addresses are refused at registration and again at
every delivery. A key may register 10 webhooks.

With Postgres, each routed delivery is stored before its first HTTP attempt;
its event body is encrypted with the platform secret. Retries survive API
restarts. Workers poll in bounded batches and claim 30-second fenced leases;
an interrupted attempt becomes available after its lease expires. The queue
deduplicates `(webhook id, event id)`, and the receiver must still deduplicate
by event id: a crash after a successful HTTP response but before recording it
can repeat that delivery. Attempt results and retry scheduling commit
together. A retry re-reads the webhook and the key's full live lineage;
deleted webhooks and revoked or expired keys receive no further attempts.
Successful and exhausted queue rows discard the body and retain deduplication
identifiers for seven days. In-memory development queues remain transient.

The durable queue starts after an event is routed to a webhook. Source-state
changes and event routing are not one transaction, so a process crash before
the first queue insert can still lose that notification. Queue limits and
exhausted retries can also prevent delivery; use the current intent state for
reconciliation. This is bounded at-least-once delivery of queued work, not an
exactly-once or complete event-history guarantee.

Each key's deliveries are queued separately and served in turn with other
keys: at most 200 wait per key (beyond that the key's oldest delivery is
dropped), at most 2 are in flight per key and a webhook receives one delivery
at a time. A webhook whose last 5 attempts failed is paused for 30 s, doubling
up to 5 minutes while it keeps failing; its deliveries wait during the pause.
Pause counters belong to the worker; a retry's scheduled delay is persisted
with Postgres. Cross-worker leases share the in-flight limits, while a worker
restart resets its pause counters.

Webhook secrets are encrypted at rest with `KLETIA_PLATFORM_SECRET` (at least
32 characters). It is required whenever `KLETIA_DATABASE_URL` is set; with the
in-memory store a development key is used and `GET /v1/health` reports
`webhooks.sealing: "development_fallback"`. `webhooks.dispatcher` reports the
answering worker's activity and `storage` (`memory` or `postgres`). With
Postgres, `queued` and `scheduledRetries` are the last shared queue snapshot;
other counters describe the answering process.

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
