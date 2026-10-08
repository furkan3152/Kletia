# Kletia Platform API v1

Kletia Platform API v1 is the integration surface for teams that want
cross-network intents in their own product. The first-party Kletia app uses
this same API for Solana and cross-network flows.

- Base URL: `https://api.kletiaai.xyz/v1` (local: `http://localhost:3001/v1`)
- Spec: `GET /v1/openapi.json` (OpenAPI 3.1)
- Types: [`@kletia/core`](../../packages/core/README.md) (intent spec), [`@kletia/sdk`](../../packages/sdk/README.md) (client)

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
hash). It is rate-limited per IP.

## Errors

```json
{ "error": { "code": "INTENT_UNSUPPORTED", "message": "…", "issues": [{ "path": "actions[0].network", "message": "…" }] }, "requestId": "…" }
```

Codes are `UPPER_SNAKE_CASE` and stable. Every response carries `X-Request-Id`.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | public | API and per-network RPC health |
| GET | `/v1/networks` | public | Chain registry plus per-network capabilities |
| GET | `/v1/protocols` | public | Protocol registry |
| GET | `/v1/assets?network=` | public | Canonical asset registry |
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
| DELETE | `/v1/webhooks/{id}` | key | Delete a webhook |
| POST | `/v1/keys` | public | Issue a developer key |
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
previous step". Response: `201 { "intent": IntentGraph }`.

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
4. Kletia verifies each reference on-chain. Same-network steps become
   `settled`; cross-network steps become `settling` until the settlement network
   reports a destination fill, then `settled` (or `failed` on refund/expiry).

A payload expires at `payload.expiresAt`; prepare again to re-quote.

### Events and webhooks

Event envelope (`KletiaEvent` in `@kletia/core`):

```json
{ "id": "evt_…", "type": "intent.step_updated", "at": "2026-10-08T12:00:00.000Z", "data": { "intentId": "…", "stepId": "…", "network": "solana", "status": "settled" } }
```

Types: `intent.created`, `intent.status_changed`, `intent.step_updated`.

Webhook deliveries are `POST` with header
`Kletia-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
Verify with `verifyWebhookSignature` from `@kletia/core`. Deliveries retry up to
3 times with backoff. Webhook URLs must be public HTTPS.

## Supported intents (v1)

| Kind | Networks | Venue |
|---|---|---|
| `swap` | Solana | Jupiter |
| `swap` | Base, Arbitrum | Relay (same-network) |
| `stake` (liquid) | Solana | Jupiter route into JitoSOL / mSOL / JupSOL |
| `transfer` | All | Native / ERC-20 / SPL (with ATA creation) |
| `bridge` (and bridge-and-swap) | Base ↔ Solana, Arbitrum ↔ Solana, Base ↔ Arbitrum | Relay |
| `deposit` | Base, Arbitrum | Aave V3 supply |

Natural-language text is compiled by a deterministic grammar (no model
involved). Unsupported wording returns `422 INTENT_UNSUPPORTED` with examples.
