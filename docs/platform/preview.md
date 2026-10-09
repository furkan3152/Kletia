# Asset-change preview ("fare breakdown")

Before anything is signed, Kletia simulates the steps of an intent and adds
up, for the **whole** intent (bridge legs included), what leaves each of your
wallets, what arrives where, what it costs and what your wallets must hold.
Every number says how it was obtained. The same preview is the guard at
prepare: a payload whose simulated effect differs from its step is never
handed to a wallet, and a payload materially worse than the preview the user
approved is refused.

Types live in `@kletia/core` (`preview.ts`: `IntentPreview`, `StepPreview`,
`aggregatePreview`, `previewDigest`, `materialChange`, `validatePreviewAck`).

## Where previews come from

| Request | Preview |
|---|---|
| `POST /v1/intents?preview=true` (also with `dryRun=true`) | `{ intent, preview }`, stage `plan`, simulated from the transactions the auction's quotes already returned; a failed simulation never fails the create (unsimulated steps are `quoted`) |
| `POST /v1/intents/{id}/steps/{stepId}/prepare` | `payload.preview` (this step, `payload.preview.quoteBinding === payload.quoteBinding`) and `preview` (the whole intent with this step freshly simulated, stage `prepare`) |
| `POST /v1/intents/{id}/preview` | Recomputed now (stage `refresh`); `?quotes=refresh` re-quotes ready steps first |
| `GET /v1/intents/{id}/preview` | The last preview computed for the intent (any stage), kept 30 minutes; `404 PREVIEW_NOT_FOUND` otherwise |
| MCP `preview_intent`, `plan_intent.preview` | A compact summary for agents (rows, payments, totals, needs, warnings; never transactions) |

The intent graph never carries a preview: webhook payloads and
`GET /v1/intents/{id}` stay the same size.

## Certainty labels

| Label | Meaning |
|---|---|
| `simulated` | The exact transactions, simulated against current state (`eth_simulateV1` with transfer tracing, Solana `simulateTransaction`) |
| `simulated-assumed-funds` | An EVM step simulated with a balance override for funds a bridge has not delivered yet; it is simulated again, without overrides, before you sign it |
| `venue-minimum` | A bridge's destination credit: the floor the venue committed to, which Kletia checks on arrival. Solver fills are never "simulated" |
| `quoted` | A venue quote, not simulated (Solana steps waiting for bridged funds: no public Solana RPC can override balances) |
| `estimated` | Derived, e.g. a typical output scaled from the expected bridge output |

Aggregated rows keep the **weakest** label of what they add up.

## Reading a preview

- `rows`: net change per network, account and asset. `expected` and `worst`
  (the bound in your disfavour: the largest debit, the smallest credit) are
  signed base units with display text and USD where priced. A row whose
  credits and debits cancel (bridged USDC that the next step deposits) has
  `role: "transit"`.
- `payments`: fixed recipients that are not your accounts.
- `fees`: network (gas, L1 data on OP-stack and Arbitrum, the Solana fee),
  venue fees from the quotes (`deducted`: already inside a lower output;
  `on-top`), and Solana rent (`refundable`).
- `approvals`: what you allow whom to spend, and `leftAfter` (the allowance
  left after the simulated step; `"0"` means nothing).
- `totals`: you pay, you get (expected and at least), paid to others, network,
  venue and extra fees, cost and the residual price difference. A total is
  `null` when an asset it needs has no price; the asset is listed in
  `totals.unpriced` (never shown as $0).
- `needs`: what your wallets must hold: the input balance, gas on arrival
  (a network where you hold no native asset), rent.
- `arrival`: the expected arrival of the last cross-network leg.
- `basis`: `simulated` (every step), `partial`, `quoted` or `unavailable`.

## Digest and `acknowledgedPreview`

Every preview has a `digest`: `sha256:` over the canonical JSON of what moves
(rows, payments and approvals with their amounts); USD values, times and fees
are excluded because they move every block.

A client that showed a preview to the user passes its digest to prepare:

```http
POST /v1/intents/int_…/steps/s1/prepare
Content-Type: application/json

{ "acknowledgedPreview": "sha256:5b0c…" }
```

Kletia looks the digest up (previews of every stage are kept 30 minutes, in
Postgres when the deployment has a database), recomputes the intent preview
with the just-simulated step, and compares:

| Change code | Materially worse when |
|---|---|
| `PREVIEW_NEW_DEBIT` | a (network, account, asset) row with a negative worst amount appears |
| `PREVIEW_WORSE_AMOUNT` | a row's worst amount drops by more than max(1 base unit, 10 bps): a bigger debit or a smaller guaranteed credit |
| `PREVIEW_RECIPIENT_CHANGED`, `PREVIEW_PAYMENT_LOWER` | an external payment's recipient differs, or its worst amount drops by more than 10 bps |
| `PREVIEW_APPROVAL_GREW` | an approval appears or grows |
| `PREVIEW_FEES_UP` | network fees plus extra costs grow by more than max(5 %, $0.05), when both are priced |

Network fees and rent are judged by the fee rule only (gas moves every
block). Anything materially worse answers:

```json
{ "error": { "code": "PREVIEW_CHANGED", "message": "…", "issues": [{ "path": "PREVIEW_WORSE_AMOUNT", "message": "…" }],
             "preview": { "…": "the fresh preview" }, "changes": [{ "code": "…", "severity": "block", "message": "…" }] },
  "requestId": "…" }
```

Show the fresh preview and prepare again with its digest; never sign without
a second approval. An unknown digest (expired, or kept by another instance
without a database) is not an error: the response carries
`Kletia-Preview-Ack: unknown` (and `previewAck: "unknown"` in the body) with
the fresh `preview` to show. A found digest with no material change answers
`Kletia-Preview-Ack: matched`. Browsers read the body field (`previewAck`):
the header is not exposed to cross-origin scripts.

## Invariants at prepare

Before a payload leaves Kletia (and before a Rule Book reserves spend), the
simulated step must pass:

| # | Rule | Refusal |
|---|---|---|
| I1 | Every transaction succeeds | `SIMULATION_FAILED` |
| I2 | Your debit of the input asset equals the step input (declared extra costs allowed on top) | `SIMULATION_ASSET_CHANGE_REFUSED` |
| I3 | No other token leaves you | `SIMULATION_ASSET_CHANGE_REFUSED` |
| I4 | Approvals only on the input token, to the venue's pinned spender, for at most the step amount | `SIMULATION_ASSET_CHANGE_REFUSED` |
| I5 | Same-network output at least the step minimum | `QUOTE_MOVED` |
| I6 | Your balance covers the input | `INSUFFICIENT_BALANCE` |
| I7 | Solana: your token accounts keep their owner, no delegate appears | `SIMULATION_ASSET_CHANGE_REFUSED` |

A leftover allowance is a warning, not a refusal.

When no endpoint can simulate, built-in venues continue with
`status: "unavailable"` and a `PREVIEW_UNAVAILABLE` warning (the adapters pin
calldata themselves); `KLETIA_PREVIEW_ENFORCE=strict` refuses with
`503 SIMULATION_UNAVAILABLE` instead, and custom contract steps and intent
link intents are always strict.

## Warning codes

Inside `PreviewIssue.code` (not API errors):

| Code | Meaning |
|---|---|
| `PREVIEW_UNAVAILABLE` | The step could not be simulated; its numbers are quoted |
| `PREVIEW_OVERRIDE_UNAVAILABLE` | No balance slot was found to assume in-flight funds; the step is quoted |
| `PREVIEW_ALLOWANCE_LEFT` | An approval leaves an allowance after the step |
| `PREVIEW_GAS_ON_ARRIVAL` | You hold no native asset on a network where a step needs your signature |
| `PREVIEW_UNPRICED` | Some assets have no price; totals that need them are null |
| `PREVIEW_STEP_QUOTED` | The step is quoted, not simulated |

Issues may also carry catalogued codes such as `INSUFFICIENT_BALANCE`
(severity `warn` at plan, `block` at prepare).

## Limits

| Limit | Value |
|---|---|
| `POST /v1/intents/{id}/preview` | 6 per minute per intent (`429 RATE_LIMITED` with `Retry-After`; MCP `preview_intent` shares it) |
| `quotes=refresh` | once per 20 s per intent, at most 4 ready steps re-quoted |
| Preview store | the latest preview per intent and every digest for 30 minutes (memory LRU of 20,000, or Postgres `kletia_intent_previews`, pruned hourly); previews over 64 KB are not stored |
| Timeouts | 2.5 s per simulation at plan (the whole plan preview is abandoned after 3 s), 6 s at prepare and refresh |

No provider is called for a preview: plan-time previews reuse the
transactions the quotes already returned, and prepare-time previews simulate
the payload itself. Only `quotes=refresh` re-quotes.

## What is not simulated

- Solver fills and bridge relays happen later, on another network, by third
  parties: the destination side is the venue's committed minimum, checked on
  arrival by settlement verification.
- Solana steps waiting for bridged funds are quoted until the funds arrive.
- MEV and state changes between the preview and inclusion: same-network
  output floors and the prepare ratio checks protect you on-chain, not the
  preview.
- Simulation sends your address and calldata to public RPCs (as every read
  does); operators can point simulation at their own nodes
  (`KLETIA_SIMULATION_RPC_URLS_<NETWORK>`).

## Errors

| Code | Status | When |
|---|---|---|
| `PREVIEW_CHANGED` | 409 | The fresh simulation is materially worse than the acknowledged preview |
| `PREVIEW_NOT_FOUND` | 404 | `GET …/preview` with no kept preview |
| `SIMULATION_UNAVAILABLE` | 503 | Strict mode, custom contracts or link intents without a simulating endpoint |
| `RATE_LIMITED` | 429 | More than 6 recomputations per intent per minute, or a second `quotes=refresh` within 20 s |
