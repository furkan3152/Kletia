# The journey: where the money is after every step

A multi-step intent moves money through several places: your wallet, a
bridge provider, your wallet on another network, a lending venue. The
**journey** (`kletia.journey/v1`) answers, for every step, where the money is,
who holds it, how much arrives at least, and what follows from it: a later
step that cannot pay its network fee, a venue that is paused, where a refund
goes if a bridge cannot fill. It is read-only and never moves money.

The journey is built by the engine from the intent graph, its asset-change
[preview](preview.md) and a few on-chain reads (gas balances, gas prices,
Solana rent, venue capacity). It is deterministic: the same inputs give the
same JSON and the same `digest`.

## Getting it

| Call | Returns |
|---|---|
| `POST /v1/intents?journey=true` (dry runs too) | `{ intent, preview, journey }`; `journey` implies the plan-stage preview and `journey.basis.previewDigest` equals `preview.digest`. `journeyReads=none` skips every account read (demo accounts). |
| `POST /v1/intents/{id}/steps/{stepId}/prepare?journey=true` | adds `journey` built on the prepare-stage preview: the itinerary at signing time. |
| `GET /v1/intents/{id}/journey` | `{ journey }` of a stored intent on its latest preview. `refresh=true` re-reads the facts (once per 10 s per intent); `reads=none` skips account reads. 404 `INTENT_NOT_FOUND`. |
| `POST /v1/intents/{id}/stop` | `{ intent, journey }` after ending the intent at its current stop (below). |
| MCP `get_journey`, and `journey` in `plan_intent` and `get_intent` | the compact form for agents ([mcp.md](mcp.md)). |

Fetch the journey with the plan and again when a step changes
(`intent.step_updated` and `intent.status_changed` events, or your webhooks),
not on a timer. `GET …/journey` allows 30 reads per intent per minute on top
of the tier limit, and results are cached for 15 s per (intent, update time,
preview digest, reads). There is no `?journey` flag on `GET /v1/intents/{id}`
or `POST …/preview`.

A journey that cannot be built never fails a create or a prepare: the field
is `null` and `GET …/journey` computes it again. Facts that could not be read
in time (2.5 s at plan, 4 s on a GET) are unknown, never zero: they become a
consequence that says so.

## Concepts

- **Stops** (`stops[]`): the places the money waits. `start` (your input
  before the first signature), `transit` (with a provider, such as Relay
  between deposit and fill), `arrival` (spent by a later step) and `end`.
  Each stop has a `holder` (`Your Base wallet`, `Relay (in transit)`,
  `Aave V3 USDC`), a `custody` (`wallet`, `venue`, `provider`, `refund-due`,
  `third-party`, `unknown`), a `state` (`upcoming`, `current`, `passed`,
  `skipped`, `failed`) and its `holdings`. Ids (`start:s1`, `transit:s1`,
  `out:s1`) are stable across polls.
- **Holdings**: `expected` and `atLeast` amounts (the bound in your
  disfavour), the certainty (`observed` on-chain, then the preview's labels:
  `simulated`, `simulated-assumed-funds`, `venue-minimum`, `quoted`,
  `estimated`), the asset's `identity` (`Circle-issued USDC (CCTP domain 6)`,
  `Your Aave V3 USDC position: 1 aBasUSDC = 1 USDC plus interest`), its
  `value` with the price `source` (`usd-par`, `jupiter`, `chainlink`, `pyth`,
  `venue-rate`, `testnet`, `unpriced`; unpriced is never $0) and its `role`
  (`spent-next` with the step and share that spend it, `kept`, `gas`,
  `position`, `paid`, `refund`). Amounts at a stop equal the fare's rows.
- **Legs** (`legs[]`): one per step, with the venue, signer, signatures,
  seconds, status, the gas delivered with the fill (`gasTopup`) and the
  **refund path** of cross-network legs: `automatic` (Relay), `after-deadline`
  (LI.FI and Across after the fill deadline), `after-cancel` (deBridge, sent
  from the destination authority, with what it `needs`), `none` (CCTP V2: a
  failed forward is indeterminate with the message hash).
- **Tracking**: a leg's `tracking` link is its main transaction (the last
  one its wallet sent; approvals come first), never the approval; a leg that
  sent several transactions lists every one in `transactions`, main first.
- **Now** (`now`): the stops the money is at, the leg it waits on, and what
  it waits for (`signature`, `settlement`, `decision`, `nothing`).
- **Stage**: `plan` while nothing was submitted, `live` while it runs,
  `final` once the intent is finished.

## Consequences

`consequences[]` are what follows from the route, each with a `severity`
assigned by rule, never by a venue:

| Severity | Meaning | What a client does |
|---|---|---|
| `block` | A later step cannot be signed, or will be refused, with the facts read. | Ask `prompt.question` and wait for an answer before the next signature. Their ids are in `blockers`. |
| `act` | Acting now avoids a likely problem. | Show it open, with the recommended option. |
| `warn` | A risk worth knowing before departure. | Show it. |
| `info` | Facts about the route. | Fold it when `collapsed` is true. |

| Kind | Rule | Raised when |
|---|---|---|
| `gas-to-continue` | R1 | A later step's network has too little gas asset to sign it (or the balance could not be read). Options: `gas-topup` (re-plan with `constraints.gasOnArrival`, Relay), `gas-leg` (a $1 SOL leg for Solana), `bring-gas`. |
| `gas-to-leave` | R2 | No gas asset arrives where the money ends up, so leaving costs a separate top-up. |
| `asset-identity` | R3 | What the token is: issuer, bridged, wrapped, receipt or liquid-staking claim. |
| `price-exposure` | R4 | A later step is priced again when the money arrives, or holds a moving asset. |
| `venue-capacity` | R5 | A venue's supply cap is smaller than the deposit, or the venue is paused or frozen (`block`), or the cap is close (`warn`). |
| `rule-book` | R6 | The key's [Rule Book](policies.md) headroom (per step, per intent, windows, schedule, approval expiry) does not cover the route. |
| `if-stopped` | R7 | Where the money waits if a later step cannot run; after a failed step: `retry`, `replan-same-venue`, `replan-any-venue`, `end-here`, `bring-back`. |
| `refund-path` | R8 | What a bridge does if it cannot fill (`act` when the deBridge cancel would need gas the destination authority lacks). |
| `allowance-left` | R9 | An approval this intent gave is not fully used. |
| `time-window` | R10 | When the plan and prepared payloads expire. |
| `idle-funds` | R11 | Money kept at a stop could earn at a listed venue (suggestions as `deposit:<venue id>` options; illiquid venues are never suggested). |
| `exit-path` | R12 | How and when the money can leave the venue it ends in. |

### Options

Every option has a stable `id`, a `label`, an `effect` with costs, `costUsd`
and an `action`:

| `action.type` | What the client does |
|---|---|
| `replan` | Plan `action.request` as a new intent (show its fare and journey, then the user signs). Used for gas top-ups and continuations. |
| `plan-new` | Plan `action.text` as a separate intent (idle funds, bring it back). |
| `retry` | Prepare the failed leg (`legId`) again. |
| `stop` | `POST /v1/intents/{id}/stop`. |
| `acknowledge` | The user takes care of it; remember the answer per intent and consequence id. |
| `link` | Open the https status page or explorer. |

Nothing tops up on its own: `constraints.gasOnArrival` is opt-in and only the
user's answer adds it. A continuation after a failed leg spends the exact
landed amount, keeps the same accounts and carries
`metadata.continues = <intent id>` (informational, never trusted).

## Ending a journey: `POST /v1/intents/{id}/stop`

Stopping skips every step that has not started (and failed ones) and leaves
the money where the journey says. It never moves money and is idempotent
(also with `Idempotency-Key`).

- Nothing started: the intent becomes `cancelled`, like `POST …/cancel`.
- A step settled: the rest is skipped with a note ("Skipped: the journey was
  ended at the Base stop after step 1.") and the intent is
  `partially_completed`; its receipt is issued as usual.
- A step is `submitted`, `confirmed`, `settling` or `indeterminate`, or holds a
  prepared payload that can still be signed: `409 INTENT_IN_FLIGHT`
  (retryable) with `Retry-After` (the payload's remaining seconds, else 30).

A stop emits `intent.step_updated` (`skipped`) and `intent.status_changed`.
The client flow for a continuation: show the continuation's fare and journey
(a dry run), then on confirmation stop the original and create the new
intent. A stop refused with `INTENT_IN_FLIGHT` aborts before anything new is
stored.

## Example (live, 2026-10-14)

"bridge 100 USDC from solana to base and deposit it into aave" as a dry run,
from a funded Solana wallet to a fresh Base account with no ETH
(`POST /v1/intents?dryRun=true&journey=true`, local API, read-only; abridged):

```json
{
  "journey": {
    "spec": "kletia.journey/v1",
    "stage": "plan",
    "basis": { "previewDigest": "sha256:1550bd91…3f47", "reads": "live", "factsAt": "2026-10-14T21:14:16.487Z" },
    "stops": [
      { "id": "start:s1", "kind": "start", "network": "solana", "custody": "wallet", "holdings": [{ "expected": { "formatted": "100" }, "asset": { "symbol": "USDC" }, "role": "spent-next" }] },
      { "id": "transit:s1", "kind": "transit", "network": "solana", "custody": "provider", "holder": { "label": "Relay (in transit)" } },
      {
        "id": "out:s1", "kind": "arrival", "network": "base", "custody": "wallet",
        "holder": { "account": "eip155:8453:0xde4bd9c9350682d24a10f5a4e4129cc4ba770d5e", "own": true, "label": "Your Base wallet" },
        "holdings": [{
          "asset": { "symbol": "USDC", "decimals": 6 },
          "identity": { "kind": "issuer", "label": "Circle-issued USDC (CCTP domain 6)" },
          "expected": { "amount": "99956189", "formatted": "99.9561" },
          "atLeast": { "amount": "99456409", "formatted": "99.4564" },
          "certainty": "venue-minimum",
          "value": { "expectedUsd": 99.96, "atLeastUsd": 99.46, "price": 1, "source": "usd-par" },
          "role": "spent-next", "next": { "legId": "s2", "portionBps": 10000 }
        }],
        "eta": { "afterFirstSignatureSeconds": 20, "certainty": "quoted" }
      },
      { "id": "out:s2", "kind": "end", "network": "base", "custody": "venue", "holder": { "label": "Aave V3 USDC" }, "holdings": [{ "expected": { "formatted": "99.9561" }, "asset": { "symbol": "aBasUSDC" }, "certainty": "estimated", "role": "position" }] }
    ],
    "legs": [
      { "id": "s1", "kind": "bridge", "venue": { "protocol": "relay", "name": "Relay" }, "status": "ready",
        "refund": { "mode": "automatic", "network": "solana", "upTo": { "formatted": "100" }, "label": "If Relay cannot fill, it refunds up to 100 USDC to your Solana wallet, minus the refund's gas.", "typicalDelay": "minutes" } },
      { "id": "s2", "kind": "deposit", "venue": { "protocol": "aave-v3", "name": "Aave V3", "venueId": "base:aave-v3:usdc" }, "status": "pending" }
    ],
    "now": { "stopIds": ["start:s1"], "legId": "s1", "waitingFor": "signature" },
    "consequences": [
      {
        "id": "gas-to-continue:out:s1", "kind": "gas-to-continue", "severity": "block", "stopId": "out:s1", "legIds": ["s2"],
        "title": "Base needs 0.00000158668 ETH more for network fees",
        "detail": "Your Base wallet holds 0 ETH; step 2 cannot be signed without about 0.00000158668 ETH more. Nothing tops up on its own.",
        "certainty": "simulated-assumed-funds",
        "facts": { "need": "1586685861077", "have": "0", "fees": "1586685861077" },
        "source": "Base balance read at 21:14 UTC; fees from the simulation",
        "options": [
          { "id": "gas-topup", "label": "Add $0.05 of ETH with the Relay leg", "recommended": true, "costUsd": 0.07,
            "effect": "Relay delivers about 0.0000207323 ETH on Base with the fill; it costs about $0.07 from the bridged amount and re-plans the intent.",
            "action": { "type": "replan", "request": { "text": "bridge 100 USDC from solana to base and deposit it into aave", "accounts": ["…"], "constraints": { "gasOnArrival": { "base": "0.05" } } } } },
          { "id": "bring-gas", "label": "I will bring ETH myself", "recommended": false, "costUsd": 0,
            "effect": "Send at least 0.00000158668 ETH to your Base wallet before that step; it holds 0 ETH now.", "action": { "type": "acknowledge" } }
        ],
        "prompt": { "question": "How should the network fee on Base be paid?", "defaultOptionId": "gas-topup" },
        "collapsed": false
      },
      { "id": "exit-path:out:s2", "severity": "info", "title": "Withdraw from Aave V3 USDC any time while liquidity lasts", "detail": "17788676 USDC available now (90% utilized)." }
    ],
    "blockers": ["gas-to-continue:out:s1"],
    "digest": "sha256:…"
  }
}
```

The same run for "bridge 50 USDC from base to solana then swap half to
JitoSOL" with empty accounts on both networks raised two blocks: Base needs
0.000001296 ETH to sign the bridge (`bring-gas`), and Solana needs
0.00224368 SOL for the swap's fees and rent (options `gas-leg`, recommended,
and `bring-gas`), plus a `warn` that the swap is priced again on arrival. The
kept half (24.8895 USDC, at least 24.765) is a `kept` holding at `out:s1`.

## Positions

`GET /v1/portfolio/{accountId}?positions=true` (and the batch
`GET /v1/portfolio?accounts=…&positions=true`) adds the account's venue
positions: Aave and SparkLend aTokens, Compound V3 balances, ERC-4626 shares
(Morpho, Spark Savings, Fluid, Yearn), Moonwell mTokens and Jupiter Lend
jlTokens, each valued in the underlying with the rate used. Venues that could
not be read are listed in `positionsUnavailable` (Kamino obligations are not
listed yet). See [api-v1.md](api-v1.md#portfolios).
