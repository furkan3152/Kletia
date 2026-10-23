# Solana venues

The Solana lending, staking, routing and payment venues added to the intent
engine in October 2026. Every one builds an unsigned transaction for the user's wallet
(the wallet is the only signer and fee payer), pins every program and account
in `@kletia/core` (`packages/core/src/protocols.ts`), checks on-chain state
before quoting, simulates the payload at prepare, and verifies landed
transactions by their instruction and token deltas. Nothing here signs,
sends or holds funds.

On-chain read-backs of every new pin (public mainnet RPC, `getAccountInfo`
and `simulateTransaction` without signatures, 2026-10-23):
[`packages/core/test/fixtures/protocols-2026-10-23.json`](../../packages/core/test/fixtures/protocols-2026-10-23.json).

## What was added

| Protocol | Action | Venues | How it executes | Verification |
|---|---|---|---|---|
| Save (ex-Solend), `save` | deposit, withdraw (exact or all) | Main pool USDC, USDT reserves (pinned by reserve address) | Engine-built: own token account (idempotent), `RefreshReserve`, `DepositReserveLiquidity` / `RedeemReserveCollateral`; the cToken lands in the wallet | Save instruction (program, tag, all 9 accounts, amount), no other Save instruction but refresh, exact liquidity spent and cTokens minted, or cTokens burned and at most their worth paid |
| Sanctum, `sanctum` | stake | JupSOL (multi-validator pool), hSOL, dSOL, bonkSOL (single-validator pools, `SP12t…`) | `DepositSolWithSlippage` with an on-chain minimum (5 bps under the pool rate); competes with the Jupiter route | Deposit instruction bound to the pool, mint and the step account's token account; LST credited at least the floor |
| BlazeStake, `blazestake` | stake | bSOL (SPL stake pool program) | Same as above; the SOL deposit fee is refunded through the referral share | Same as above |
| Kamino, `kamino` | discovery (deposit / withdraw served, not offered yet) | JLP market USDC, USDT, PYUSD; Altcoins market USDC | KTX transactions checked against each venue's own market and authority | As main-market Kamino |
| Jupiter, `jupiter` | swap venue filter | `dexes:<families>` or `avoid:<families>` | Families map to Jupiter AMM labels sent as `dexes` / `excludeDexes`; the quoted route is re-checked | Unchanged |
| Solana Pay, `solana-pay` | transfer (named only) | SOL and SPL tokens on Solana and Solana Devnet | Transfer with a per-step reference key appended read-only to the transfer instruction; `solana:` transfer URL helpers | Transfer instruction naming the reference, full amount credited to the recipient |

## Save

- Venues: `solana:save:usdc`, `solana:save:usdt` (program
  `So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo`, market
  `4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY`). Each prepare reads the
  reserve: Save owner, 619-byte version-1 layout, market, mint, supply vault,
  cToken and decimals equal the pins, and the market authority must derive
  from the market. The deposit limit and available liquidity are checked
  before planning.
- Neither instruction takes a minimum. The quote uses the reserve's stored
  rate; refreshing it accrues interest, which lowers the cTokens a deposit
  mints by a fraction and raises what a withdrawal pays. The guarantee is
  held 10 bps under the deposit quote (`floor: "claimed"`), and a withdrawal
  redeems the fewest cTokens that pay at least the amount.
- Journey facts: `positionOf` (cTokens in the wallet at the stored rate) and
  `venueCapacity` (room under the deposit limit, available liquidity).
- Structured actions name it with `protocol: "save"`. Sentences ("deposit 10
  USDC into solend") need the reader hook below.

## Stake pools

Pools are one table, `SOLANA_STAKE_POOLS`, mirrored in `VENUE_CONTRACTS`. A
protocol's adapter serves each of its pools and picks the pool by the LST
mint of the route, never by symbol. Pool, mint and validator list come from
Sanctum's LST list (`igneous-labs/sanctum-lst-list`); the reserve and fee
accounts were read from the pool, and `DepositSolWithSlippage` was simulated
on each pool from a funded account (the exact minimum passes, a higher one
fails with `ExceededSlippage`). An un-updated pool for the current epoch, a
SOL deposit authority or any drifted field refuses.

## Jupiter venue filter

A swap's `params.provider` may carry a venue filter. Families (`raydium`,
`orca`, `meteora`, `phoenix`, `openbook`, `manifest`, `solfi`, `humidifi`,
`zerofi`, `pumpfun`) map to Jupiter AMM labels read from Jupiter's
`/swap/v1/program-id-to-label`. Lifinity is not listed there any more and
cannot be named.

```json
{ "kind": "swap", "network": "solana", "amount": "1", "from": "SOL", "to": "USDC", "params": { "provider": "avoid:phoenix,solfi" } }
```

`dexes:raydium,orca` routes only through those families, `avoid:...` around
them (at most 32 characters, as step refs keep). The planned step records
the filter so every prepare quotes with it, and a quote whose route breaks
it is refused (`PROVIDER_TRANSACTION_REJECTED`). Unknown families refuse
with the list. `encodeJupiterVenueFilter` is the typed entry point.

## Solana Pay

- Named only (`protocol: "solana-pay"` on a transfer action). The step's
  reference is sha256 of the intent and step ids read as a public key (no
  secret key exists for it); every prepare of the step carries the same one
  and returns it as `trackingId`.
- `encodeSolanaPayTransferUrl` / `parseSolanaPayTransferUrl` build and read
  `solana:<recipient>?amount=…&spl-token=…&reference=…&label=…&message=…&memo=…`
  per the specification; `solanaPayStepUrl(step, reference)` gives the URL
  matching a step's transaction, and `findSolanaPayTransactions(network,
  reference)` lists the signatures that name a reference (read-only).

## Reader hooks (for the integrator)

The sentence reader is unchanged in this round. These shapes need hooks:

- "deposit 10 USDC into solend [on solana]", "withdraw 10 USDC from save
  finance" → lending word `solend|save finance|save lending` → `save`
  (`LENDING_VENUES` / `LENDING_WORDS`).
- "stake 1 SOL with blazestake|solblaze|bsol" → `LIQUID_STAKING_TOKENS`
  entry `{ symbol: "bSOL", provider: "BlazeStake" }` and planner
  `STAKE_PROTOCOLS.blazestake`; "stake 1 SOL with hsol|dsol|bonksol" →
  `{ symbol: "hSOL" | "dSOL" | "bonkSOL", provider: "Sanctum" }`.
- "deposit 10 USDC into kamino jlp-usdc" → add `kamino` to the vault
  protocols (grammar and clarify catalog), then switch the JLP / Altcoins
  venues' `actions` to deposit and withdraw.
- "swap 1 SOL to USDC via phoenix" / "... avoiding raydium" →
  `params.provider = encodeJupiterVenueFilter({ mode: "only" | "avoid", families })`.
- "pay 5 USDC to <address> with solana pay" → transfer action with
  `protocol: "solana-pay"`.

## Not added

- MarginFi v2: deposits need a marginfi account (a fresh keypair signer, or
  the newer PDA initialiser) and withdrawals carry every active balance's
  bank and oracle as remaining accounts for the health check; not built
  without a verified account flow.
- Drift spot lending: the perps module (`apps/api/src/platform/perps/drift.ts`)
  already builds Drift's instruction layouts; skipped to avoid a second copy.
- Lulo and Kamino kVaults: no keyless public transaction API (Lulo needs an
  API key), and kVault withdrawals depend on per-vault reserve allocations;
  not built.
- Meteora DLMM / DAMM v2 were already covered (named pools through Jupiter).
