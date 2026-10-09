# Cross-network venues: Relay, LI.FI and deBridge DLN

Kletia moves value between networks through three venues. For every
cross-network `bridge` step the planner asks all venues that can serve the
route for a quote in parallel and picks one with the venue auction
(`apps/api/src/platform/engine/auction.ts`). This page describes what each
venue serves, what Kletia checks before a payload reaches a wallet, and how a
step is verified and settled.

Every fact below was checked live on 2026-10-09 against mainnet and the
providers' APIs. Nothing was signed or sent.

## Venues at a glance

| | Relay | LI.FI | deBridge DLN |
|---|---|---|---|
| Adapter | `adapters/relay.ts` | `adapters/lifi.ts` | `adapters/debridge.ts` |
| Origins | Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS, Solana | the EVM networks where the LiFiDiamond is pinned (Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS) | the five EVM networks and Solana |
| Destinations | the same networks | the five EVM networks and Solana | the same networks |
| Assets | any pair Relay quotes; same-network swaps on Base and Arbitrum One | same canonical ERC-20 asset on both sides (USDC, WETH, ...), USDC only to Solana; no native assets | canonical (registry) assets on both sides, including native assets and cross-asset orders |
| Bridges used | Relay solvers | Across V4 (EVM to EVM) and Polymer CCTP (USDC, EVM to EVM or Solana) | DLN solvers |
| Price | Relay's quoted minimum (slippage applied) | the exact Across output or CCTP mint; LI.FI keeps 0.25% | an exact take amount, plus a fixed fee in the origin's native asset |
| Speed | seconds | Across seconds; Polymer CCTP about 18 minutes | seconds |
| Key | `RELAY_API_KEY` (required in production) | `LIFI_API_KEY` (optional; keyless: 75 quotes per two hours) | `DEBRIDGE_ACCESS_TOKEN` (optional) |

## How the auction picks a venue

The auction (engine core) ranks quotes by net guaranteed output:

```
net = minimumOutput - extraCosts (converted into the output asset)
```

then by fewer estimated seconds, then by fewer wallet transactions. DLN's
fixed fee is its `extraCosts` entry. A quote is not eligible when it is slower
than `constraints.maxSeconds` (default 600 s), when its extra costs cannot be
priced (for example DLN's fee in POL on Polygon, which has no price source), or
when it delivers another asset. Losing quotes are recorded as `quote` evidence
on the step. `constraints.preferProtocols` / `avoidProtocols` and phrases such
as "via lifi" or "via debridge" narrow the candidates.

For an exact-output venue (an Across fill, a CCTP mint, a DLN order) the step
minimum sits 5 bps (at most the step's slippage) below the exact amount. A
fresh quote at prepare that moved by less still prepares instead of failing
`QUOTE_MOVED`; the payload itself still guarantees the exact amount. Live, a
DLN take amount moved by 11 base units within one second.

### Live comparison, 25 USDC, 50 bps slippage (2026-10-09, local API)

`POST /v1/quotes` and dry-run plans (`POST /v1/intents?dryRun=true`), with
Jupiter's ETH price ($2,500) and SOL price ($110) for the fees:

| Route | Relay (minimum) | LI.FI (minimum, tool) | DLN (minimum, net of fee) | Winner |
|---|---|---|---|---|
| Base → Arbitrum One | 24.849587 | **24.915380**, Across, ~20 s | 24.655881, net 22.156298 (0.001 ETH) | LI.FI |
| Base → Solana | **24.847553** | 24.925031, Polymer CCTP, ~18 min (not eligible under 600 s) | 23.991052, net 21.490942 (0.001 ETH) | Relay |
| Solana → Base | **24.848496** | not offered (Solana origin) | 23.978892, net 22.328968 (0.015 SOL) | Relay |
| Ethereum → Base | 24.851605 | **24.919124**, Across | 24.634516, net 22.134057 (0.001 ETH) | LI.FI |

With `constraints.maxSeconds: 3600`, Base → Solana goes to LI.FI's Polymer CCTP
route (24.925031). DLN's fixed fee makes it uncompetitive for small amounts;
it wins at size (for example 10,000 USDC, where its exact take of about 10 bps
under the amount beats LI.FI's 0.25% fee).

## What Kletia checks before a payload reaches a wallet

All checks run at plan and again at prepare, so a quote that prepare would
refuse never wins the auction. Every address comes from `VENUE_CONTRACTS` in
`@kletia/core`; none is taken from a provider response.

### Relay

- EVM calls may only approve the input token for, and call, pinned Relay
  contracts: the depository alone for a same-asset bridge; the depository, the
  ERC-20 router or the approval proxy for routes with a swap.
- A depository call must decode as `depositErc20(depositor, token, amount, id)`
  or `depositNative(depositor, id)` with the step account as depositor, the
  input token and exactly the step amount (as value for native deposits). A
  same-asset bridge makes exactly one deposit.
- Approvals are at most the step amount and only for the contract called next.
- Solana deposits may only invoke the pinned depository program
  (`99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2`, the primary instruction),
  ComputeBudget, Token and Associated Token programs.

### LI.FI

- The quote is requested with `allowBridges` limited to the tools Kletia can
  decode (`across`, `polymerStandard`), `allowExchanges=none` and
  `allowDestinationCall=false`. `near` and other Solana tools are never asked
  for; Solana-origin LI.FI routes are not offered (their router program's
  owner is unverified, and `near` pays a fresh deposit address).
- The transaction targets the pinned LiFiDiamond on the origin network, is
  sent by the step account and carries no value. Kletia builds the exact
  approval of the diamond itself.
- The diamond call is decoded (`swapAndStartBridgeTokensViaAcrossV4`,
  `startBridgeTokensViaAcrossV4`, `swapAndStartBridgeTokensViaPolymerCCTP`,
  `startBridgeTokensViaPolymerCCTP`) and `BridgeData` must carry the quote's
  `transactionId` and tool, the input token, the recipient (or LI.FI's non-EVM
  sentinel for Solana), the destination chain id, and no destination call.
- Source swaps may only be LI.FI's fee collection through the pinned
  FeeForwarder in the input token; together they pull exactly the step amount,
  and the fees are capped at 1%.
- Across: recipient, refund address (the step account), input and output
  tokens, an empty message and a fill deadline at least ten minutes out.
- Polymer CCTP: refund recipient (the step account), no hook data, a known
  finality threshold; to Solana, the Solana receiver is the recipient's wallet
  and the CCTP mint recipient is the recipient's USDC token account, derived
  by Kletia, which must already exist.
- The output the calldata guarantees covers LI.FI's `toAmountMin` and never
  exceeds the bridged amount (an unfillable quote would only stall).

### deBridge DLN

- Orders are created with `prependOperatingExpenses=false`, so the order gives
  exactly the step amount. The user keeps the patch authority on the origin,
  a cancellation refunds the user's origin account
  (`srcAllowedCancelBeneficiary`), and the destination order authority is the
  user's account: the same address on another EVM network, or the recipient
  across VMs (the step then warns that only that account can cancel an
  unfilled order).
- EVM: the transaction targets the pinned DlnSource (also the exact-approval
  spender). `createSaltedOrder` is decoded: give token and amount, take chain,
  token and amount, recipient, authorities, no external call, no affiliate fee,
  no permit. The value is exactly the fixed fee (plus the amount for a native
  input), and the fixed fee must equal `DlnSource.globalFixedNativeFee()` read
  on-chain (0.001 ETH on the ETH networks, 0.5 POL on Polygon).
- Solana: the transaction may only invoke ComputeBudget and the pinned DLN
  source program `src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4`, with no address
  lookup tables and the step account as the only signer.
  `create_order_with_nonce` is decoded with the same argument checks, the
  maker, the program state PDA (`["STATE"]`) and the input mint are checked,
  and the fixed fee must equal the state account's `fixed_fee` (0.015 SOL).
  Kletia re-assembles the transaction from the validated instructions with a
  fresh blockhash and simulates it.
- A same-asset order may not take more than it gives.

## Verification and settlement

| | Submitted references are bound when | The step settles when |
|---|---|---|
| Relay (EVM) | the landed transactions reproduce the prepared payload exactly (quote binding) | Relay reports the request filled and the fill credits the recipient on the destination |
| Relay (Solana) | the deposit debited the amount and Relay attributes it to a request quoted for the step: `GET /requests/v3?depositTxHash=` with `RELAY_API_KEY`, otherwise only `GET /intents/status/v3` of the quoted request ids | as above |
| LI.FI | quote binding, and the pinned diamond emitted `LiFiTransferStarted` with the prepared `transactionId` | `GET /v1/status` reports `DONE`/`COMPLETED` for that `transactionId` to the recipient, in the output token, for at least the calldata's floor, and the receiving transaction credits the recipient on-chain. `PARTIAL` is a mismatch, `REFUNDED` and `FAILED` fail the step, unindexed stays settling. |
| DLN (EVM) | quote binding, and the pinned DlnSource emitted `CreatedOrder` for a quoted order id whose order matches the landed calldata | the order is `Fulfilled` / `SentUnlock` / `ClaimedUnlock` and the pinned DlnDestination's `FulfilledOrder` for that order pays the recipient the output token, at least the order's take amount. A cancelled order fails the step as refunded. |
| DLN (Solana) | the order debited the amount and DLN's order index lists a quoted order for the signature | as above; on a Solana destination, the fill credits the recipient at least the step's lowest guaranteed amount |

A step that never settles goes to manual review after three hours. An
unfilled DLN order stays `Created`; only its destination order authority can
cancel it, on the destination network.

## Relay API migration (requests v2 to v3)

Relay deprecated `GET /requests/v2` (throttled since 2026-09-01, retired
2026-11-24). Kletia now reads settlement status from `GET /intents/status/v3`
(keyless; adds `failReason`, shown in step failures) and looks deposits up with
`GET /requests/v3?depositTxHash=` only when `RELAY_API_KEY` is set (v3 needs
`x-api-key` and returns only requests created under the same integrator's
keys, so the key is also sent on quotes). Without a key no by-hash lookup is
made; a deposit is bound only through the status of a request id quoted for
the step, which fails closed (it waits, and goes to manual review after an
hour if never attributed).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_API_KEY` | unset | Required in production: Relay quotes need a key from 2026-10-02, and request lookups by deposit hash only work with it. |
| `RELAY_API_URL` | https://api.relay.link | Relay API base URL. |
| `LIFI_API_KEY` | unset | LI.FI key (`x-lifi-api-key`). Keyless quoting allows 75 quotes per two hours; after a 429 LI.FI is skipped for a minute. |
| `LIFI_API_URL` | https://li.quest/v1 | LI.FI API base URL. |
| `DEBRIDGE_ACCESS_TOKEN` | unset | deBridge access token (`accesstoken` query parameter). |
| `DEBRIDGE_API_URL` | https://dln.debridge.finance/v1.0 | DLN order API. |
| `DEBRIDGE_TRACKING_URL` | https://dln-api.debridge.finance | DLN order-tracking API (fill transaction of an order). |

## Known limits

- LI.FI: no native-asset routes, no Solana origin, no Across to Solana, no
  Mayan or Relay-through-LI.FI tools (their recipients cannot be verified from
  the calldata). Keyless rate limits make a key necessary in production.
- DLN: on Polygon the fixed fee is in POL, which has no price source yet, so
  DLN is left out of auctions there (it still serves "via debridge").
  Solana-origin orders also pay order account rent (a few thousandths of a
  SOL) that is not in the step's extra costs. The destination order authority
  for a cross-VM route is the recipient; pass the user's own account on the
  destination network as recipient to keep cancellation rights.
- Relay: a by-hash lookup needs `RELAY_API_KEY`; without it, attribution of a
  Solana deposit depends on Relay's status of the quoted request ids.
