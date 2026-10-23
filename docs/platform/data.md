# Data API

Read-only data for dashboards: everything a set of wallets holds on every
network Kletia supports, its lending, vault, staking and loan positions, the
calling key's Kletia activity, and market data (venue rates, prices, network
status). The desk shows it at `/app/dashboard`; the same endpoints are open to
integrators under `/v1/data/*`.

Nothing here signs, sends or plans a transaction. Values are advisory reads.

## Honest values

Every value says where it comes from and when it was read:

```json
{ "usd": 1204.55, "source": "chainlink", "asOf": "2026-10-23T12:00:04.000Z" }
```

A value Kletia does not know is `null` with a `reason`, never `0`:

```json
{ "usd": null, "source": "unpriced", "asOf": null, "reason": "No price source covers this asset." }
```

Sources: `usd-par`, `jupiter`, `chainlink`, `pyth`, `venue-rate`, `testnet`,
`unpriced` (prices), `adapter` (an on-chain read through a venue adapter),
`aave-oracle` (an Aave pool's own base-currency valuation), `lending-metrics`
(the venue rate reader), `health-probe`, `snapshot` (this API's own earlier
readings) and `kletia` (Kletia's stores and sums).

Accounts, venues and markets that could not be read are listed in `failures`.
Totals then cover the known part only: `totals.complete` is `false` and
`totals.net.reason` says how much was left out.

## Wallet sets

`evm` and `solana` take comma-separated addresses: at most two of each.
`lane` is `production` (default: Base, Arbitrum One, Ethereum, OP Mainnet,
Polygon PoS, Solana) or `testnet` (Arc Testnet, Arbitrum Sepolia, Solana
Devnet). Every address is read on every network of the lane its VM runs, so
two EVM and two Solana addresses are at most 12 accounts.

## Endpoints

| Endpoint | What it returns | Budget units |
|---|---|---|
| `GET /v1/data/portfolio?evm=&solana=&lane=` | `{ portfolio }`: holdings, positions, debts, health, totals, allocation, `change24h`, `pnl`, failures | one per account |
| `GET /v1/data/positions?evm=&solana=&lane=` | positions, debts and health (same read and cache as the portfolio) | one per account |
| `GET /v1/data/history?evm=&solana=&limit=` | the calling key's intents, receipts and links, newest first (API key required) | one |
| `GET /v1/data/markets/yields?network=&asset=&lane=` | supply APYs of every venue, best first | one |
| `GET /v1/data/markets/prices?symbols=&network=&lane=` | USD prices of listed assets (default ETH, SOL, POL, cbBTC, wstETH, USDC, USDT; at most 20) | one |
| `GET /v1/data/markets/status` | network status from the health probe; route statistics when the deployment records them | one |
| `GET /v1/data/export?dataset=&format=` | `holdings`, `positions` (wallet set) or `history` (key) as `csv` (default) or `json`, as a download | as the read |

Every endpoint accepts publishable keys (`kl_pub_`) from the project's allowed
origins. Without a key the portfolio, positions, market and export reads are
public, like `GET /v1/portfolio`.

### Portfolio

- **Holdings**: native and listed tokens of every account (`GET /v1/portfolio`
  reads), each with its USD value.
- **Positions**: Aave V3 and SparkLend aTokens, Compound V3 balances, Morpho,
  Spark Savings, Fluid and Yearn vault shares, Moonwell mTokens and Jupiter
  Lend jlTokens (`kind`: `supply` or `vault`), valued in the underlying;
  liquid-staking tokens in the wallet (`kind: "staking"`, `inWallet: true`:
  their value is already in the wallet total and is not counted twice);
  Aave V3, SparkLend and Compound V3 debt (`kind: "borrow"`).
- **Health**: one row per loan. Aave V3 and SparkLend report their health
  factor (`Pool.getUserAccountData`); below 1.5 is `warning`, below 1.1
  `critical`. Compound V3 has no health factor: the row says whether the
  account can be liquidated now. Kamino obligations are not read yet and are
  listed as `unknown`. Markets without debt are left out.
- **Totals**: `net = wallet + positions - debt`, priced parts only.
- **Allocation**: the priced gross value (holdings and supplied positions) by
  network, asset and protocol (`wallet` for holdings that are not deployed),
  with each slice's `share`.
- **Estimates**: `change24h` compares the net value with this API instance's
  reading from about 24 hours ago (within two hours); `pnl` with its first
  reading of the same wallets. Both carry `estimate: true` and count deposits
  and withdrawals as changes: they are not realised profit. Readings live in
  the instance's memory (a hash of the wallet set, no addresses), at most one
  every 20 minutes; a reading is kept only when no account or market failed.

### Yields

Every lending, savings and vault venue of the lane: EVM venues through the
venue rate reader (current supply rate, or realised share-price growth for
vaults: `apyBasis`), Solana venues through their adapters. A venue whose rate
cannot be read stays in the list with `apy: null`. `depositText` is a
sentence for `POST /v1/intents` or the desk composer with an `[EDIT AMOUNT]`
placeholder to replace, for example
`Deposit [EDIT AMOUNT] USDC into Aave V3 USDC on Base`. The sentence reader
reads it as is: the full venue name picks that venue (a Kamino JLP reserve,
a Morpho vault) and the placeholder makes it ask the amount.

### History

The intents the calling key owns (`GET /v1/intents`), the receipt issued for
each finished one and the key's intent links, merged newest first. With
`evm` / `solana`, only intents planned for those wallets are listed (links
are not tied to a wallet and are left out).

### Export

CSV follows RFC 4180: a header row, CRLF line ends, cells quoted when they
hold a comma, quote or line break. Unknown values are empty cells. Text cells
starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` so a
spreadsheet never runs them as formulas. The SDK's `data.exportCsv` and the
desk build the same file locally with `@kletia/core`'s `dataHoldingsCsv`,
`dataPositionsCsv` and `dataHistoryCsv`.

## Limits and caching

On top of the tier limit, the data budget: 240 units a minute per API key
(publishable keys included), 60 a minute per address without one (429
`RATE_LIMITED` with `Retry-After`). Portfolio and positions are cached 15 s
per wallet set (and the underlying account reads 15 s per account), yields
60 s, prices 30 s, status 15 s.

## SDK

```ts
import { KletiaClient } from "@kletia/sdk";

const kletia = new KletiaClient({ publishableKey: "kl_pub_…" });
const portfolio = await kletia.data.portfolio({ evm: "0x…", solana: "9WzD…" });
const { positions, health } = await kletia.data.positions({ evm: "0x…" });
const { yields } = await kletia.data.yields({ asset: "USDC" });
const { prices } = await kletia.data.prices({ symbols: ["ETH", "SOL"] });
const status = await kletia.data.status();
const csv = await kletia.data.exportCsv("holdings", { evm: "0x…" });
// Server side, with a secret key:
const history = await new KletiaClient({ apiKey: process.env.KLETIA_API_KEY }).data.history({ limit: 20 });
```

## Route statistics

`routes` in `GET /v1/data/markets/status` is `null` (with `routesReason`)
until the deployment installs a source with `configureRouteStatsSource` (the
engine's per-venue quote statistics: attempts, latency, failure rate and
circuit-breaker state per network pair).
