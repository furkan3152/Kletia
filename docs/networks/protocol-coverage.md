# Protocol coverage (round 7)

What each network can do through Platform API v1, cell by cell, and how it is
kept true. The table is data in
[`apps/api/src/scripts/coverageMatrix.ts`](../../apps/api/src/scripts/coverageMatrix.ts):
one sentence per cell and what must happen to it.

- **Offline gate**: `apps/api/src/platform/engine/__tests__/protocolCoverage.test.ts`
  plans every cell against one stub adapter per protocol of the capability
  index (`capabilityIndex()` in `@kletia/core`), so the grammar, the planner
  and the registry cannot drift apart.
- **Live gate**: `npm run verify:coverage -w @kletia/api -- --api <url> [--follow] [--out <file>]`
  plans every cell with `POST /v1/intents?dryRun=true` (nothing is stored,
  signed or sent). A cell either plans with one of the protocols it names, or
  is refused with INTENT_UNSUPPORTED that offers a sentence that plans (a
  guided refusal; `--follow` plans the offered sentences too). A bare
  refusal, a wrong venue or a wrong output fails the gate. A venue that
  cannot quote right now (market caps, illiquid reserves, RPC) is reported as
  `venue`, and fails only with `--strict`.

Evidence of the last live run (local API, 2026-10-15):
[`evidence/round7/coverage-matrix-2026-10-15.json`](evidence/round7/coverage-matrix-2026-10-15.json).
On-chain read-backs of every new pin (public RPCs, chain id checked,
`eth_call` simulations only, nothing signed): the JSON files in `docs/networks/evidence/round7/` (DEX pools and quotes in [`dex.json`](evidence/round7/dex.json), lending and staking reads in [`lending-lst-testnet.json`](evidence/round7/lending-lst-testnet.json), Solana pools and programs in [`solana.json`](evidence/round7/solana.json)).

## Coverage

| Network | Swap venues | Lend / vault venues | Stake | Testnet demo |
|---|---|---|---|---|
| Ethereum | Uniswap V3, PancakeSwap V3, Curve 3pool (+ Relay) | Aave V3 (+USDT, wstETH, cbBTC), Compound V3 (+wstETH; round 9: USDT, USDS), Morpho (+Steakhouse USDC, USDT, ETH; round 9: Spark Blue Chip USDT, Steakhouse Prime USDT, sky.money USDS, Gauntlet WETH Prime), SparkLend, Spark Savings, Fluid, Yearn V3, Sky Savings (sUSDS, sDAI; round 9), Ethena sUSDe (deposit only; round 9) | Lido, Rocket Pool, ether.fi, Stader, Mantle LSP, Frax Ether, Kelp and Renzo (round 9) | - |
| Base | Uniswap V3, Aerodrome, PancakeSwap V3 | Aave V3 (+wstETH, cbETH), Compound V3 (round 9: +AERO), Morpho (round 9: +Steakhouse High Yield USDC, Grove x Steakhouse USDC, Steakhouse EURC), Moonwell, Spark Savings, Fluid | buy wstETH or cbETH at market (a swap), or bridge and stake | - |
| Arbitrum One | Uniswap V3, PancakeSwap V3, Camelot V3, Curve USDC / USDT0 (round 9) | Aave V3 (+USDT0, wstETH), Compound V3 (+USDT0), Morpho (round 9: +USDT0), Spark Savings, Fluid | buy wstETH, or bridge and stake | - |
| OP Mainnet | Uniswap V3, Velodrome | Aave V3 (+USDT, wstETH), Compound V3 (+USDT), Moonwell, Spark Savings, Morpho (round 9: +Re7 WETH) | buy wstETH (price guard decides), or bridge and stake | - |
| Polygon PoS | Uniswap V3 ("ETH" is WETH) | Aave V3 (+USDT0, wstETH), Fluid, Compound V3 USDT0, Morpho (USDC, USDT0; round 9: WETH) | buy wstETH with WETH | - |
| Solana | Jupiter (+ named Raydium, Orca, Meteora; venue filter `dexes:` / `avoid:`) | Kamino (+ JLP / Altcoins reserves for discovery), Jupiter Lend, Save main pool (structured actions) | Jito, JupSOL, hSOL, dSOL, bonkSOL and bSOL stake pools, Marinade (each competes with the Jupiter route), native staking | Solana Pay transfers (named) |
| Arc Testnet | - | - | - | USDC / EURC transfers, CCTP V2 |
| Arbitrum Sepolia | Uniswap V3 (test tokens) | Aave V3 USDC | - | swap, deposit, CCTP V2 |
| Solana Devnet | - | - | native staking | stake, CCTP V2 arrivals |

Round 9 venues, their checks and the requested venues that were not added
are listed in [EVM protocols (round 9)](../platform/evm-protocols.md).

## How the engine reads these cells

- **A deposit that names no venue** ("deposit 100 USDC on base") is never
  given a venue silently. The clarify layer asks VENUE_MISSING with the
  venues of the capability index; the strict grammar refuses and names them,
  with a sentence that works ("deposit 100 USDC into aave on base").
- **Staking ETH off Ethereum** ("stake 1 ETH on base") is refused with both
  ways that work: buy a liquid staking token there at market ("swap 1 ETH to
  wstETH on base", never called a stake), or bridge and stake ("bridge 1 ETH
  from base to ethereum then stake it with lido").
- **ETH on Polygon PoS** is WETH (POL is the gas token): the strict grammar
  reads it so with a note; the clarify layer asks, WETH suggested.
- **USDT** resolves to USDT0 where that is the canonical Tether (Arbitrum One,
  Polygon PoS).
- **Borrowing** is not available yet: "borrow ..." is refused with what
  Kletia can do instead (deposit as collateral).
- **Solana liquid staking** runs an auction: the stake pool and the Jupiter
  route quote the same token, and the one that guarantees more wins.
- **Native SOL staking** ("stake 2 SOL natively", "... with validator
  <vote account>") is planned only when named, or on Solana Devnet (the only
  staking there). The stake account is the wallet's; Kletia never unstakes.
- **Testnets**: a preview of an intent on a testnet carries
  `PREVIEW_TESTNET` (test tokens have no market value); test-token swaps are
  checked against the pool quote only, with slippage capped at 1 %.

## Last live run (2026-10-15)

68 cells: 58 planned, 7 guided refusals (each offered sentence planned too), 0 failures. Venues that could not
take a deposit at that moment, each refused by its own guard (fail closed):
Moonwell USDC on Base (over 99 % borrowed, VENUE_ILLIQUID) and the two
Morpho Compound vaults on Polygon PoS (market caps reached,
RESERVE_UNAVAILABLE). The JSON file records each cell's verdict and venue.
