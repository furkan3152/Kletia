# Data API

Read-only data for dashboards: everything a set of wallets holds on every
network Kletia supports, its lending, vault, staking and loan positions, its
whole on-chain transaction history with PnL estimates and a value series, the
calling key's Kletia activity, and market data (venue rates, prices, network
status). The desk shows it at `/app/dashboard` and `/app/history`; the same endpoints are open to
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
readings) and `kletia` (Kletia's stores and sums), `kamino-api` (Kamino's
obligation figures), the history providers (`etherscan`, `alchemy`,
`helius`, `solana-rpc`), historical prices (`defillama`, `coingecko`) and
`fifo` (the cost-basis estimate).

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
| `GET /v1/data/export?dataset=&format=` | `holdings`, `positions` (wallet set), `history` (key) or `transactions` (one page, same callers and filters) as `csv` (default) or `json`, as a download | as the read |
| `GET /v1/data/transactions?…` | on-chain history: classified, priced, linked to Kletia intents (see [Transactions](#transactions)) | one per account |
| `GET /v1/data/transactions/:id` | one transaction (`<network>:<hash>`) of the wallets | one per account |
| `GET /v1/data/pnl?period=` | FIFO realized and unrealized estimates by asset (`24h`, `7d`, `30d`, `all`) | two per account |
| `GET /v1/data/snapshots?range=` | value series of a tracked set (`24h`, `7d`, `30d`, `all`) | one |
| `GET /v1/data/summary` | one compact object for an assistant | two per account |
| `GET`, `POST`, `DELETE /v1/data/tracking` | the signed-in desk wallet's tracking opt-in | none |

Every endpoint accepts publishable keys (`kl_pub_`) from the project's allowed
origins. Without a key the portfolio, positions, market and export reads are
public, like `GET /v1/portfolio`.

The history reads (transactions, pnl, snapshots, summary) take one of two
callers, else 401 `DATA_CALLER_REQUIRED`:

- **A desk wallet session** (`Kletia-Account-Session`, first-party origin
  only): the read covers that wallet's tracked set and nothing else; `evm`
  and `solana` are ignored. Until tracking is on: 404 `DATA_NOT_TRACKED`.
- **An API key** (publishable keys too) with `evm` / `solana`: on-chain
  history is public, so any addresses may be read, within the data budget.
  The rule book has no notion of addresses a project owns (`accounts.allow`
  limits what an agent may spend from, it proves nothing), so a key gets the
  public reads only: no tracking, no snapshots, and Kletia links only to the
  key's own intents.

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
  account can be liquidated now. Kamino obligations are read from Kamino's
  API for every pinned market (Main, JLP, Altcoins): collateral as a
  `supply` position, debt as a `borrow`, health factor = liquidation limit /
  borrow-factor-adjusted debt (source `kamino-api`); an unreadable market is
  `unknown`. Markets without debt are left out.
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

### Extras

`GET /v1/data/positions?extras=true` adds what the portfolio read does not
cover, each section with `rows`, `reason` (null when read in full), `source`
and `asOf`:

- `perps`: open GMX v2 and Hyperliquid positions of every EVM address and
  Drift positions of every Solana address (mainnet only), with the account;
  a venue that could not be read is named in `reason`;
- `orders`: open native orders (CoW Protocol, Jupiter Trigger and Recurring);
- `automations`: the caller's automations (its API key's, or the desk
  wallet's);
- `agentSpend`: for an API key, the 24 h / 7 d USD spend of every agent key
  below it.

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

### Transactions

`GET /v1/data/transactions` lists every transaction of every account of the
wallet set, newest first:

```json
{
  "id": "base:0x…", "network": "base", "hash": "0x…", "account": "eip155:8453:0x…",
  "time": "2026-10-20T10:00:00.000Z", "block": 37000200, "kind": "swap", "status": "success",
  "legs": [
    { "asset": { "symbol": "ETH", "address": null, "decimals": 18, "id": "eip155:8453/slip44:60" }, "amount": "0.1", "direction": "out", "usdAtTime": 412.5, "priceSource": "defillama" },
    { "asset": { "symbol": "USDC", "address": "0x8335…", "decimals": 6, "id": "eip155:8453/erc20:0x8335…" }, "amount": "250", "direction": "in", "usdAtTime": 249.9, "priceSource": "defillama" }
  ],
  "fee": { "asset": { "symbol": "ETH", … }, "amount": "0.000001", "usd": 0.004, "reason": "Execution fee only: the L1 data fee of this network is not included." },
  "counterparty": "0x6131…", "protocol": { "id": "kyberswap", "label": "KyberSwap", "role": "aggregator-router" },
  "method": "swap", "kletiaIntentId": null, "kletiaReceiptId": null, "source": "etherscan",
  "explorerUrl": "https://basescan.org/tx/0x…"
}
```

**Providers** (each optional; a network none of them serves fails closed in
`coverage` with the variables that would enable it, never as "no history"):

| Network | Provider | Variable | Notes |
|---|---|---|---|
| Base, Arbitrum, Ethereum, OP, Polygon, Arbitrum Sepolia | Etherscan V2 (`txlist`, `tokentx`, `txlistinternal`) | `ETHERSCAN_API_KEY` | one key for every chain id; on Base and OP the fee is the execution fee only |
| same | Alchemy `alchemy_getAssetTransfers` | `ALCHEMY_API_KEY` | used when Etherscan is not configured; no fees, no failed transactions |
| Solana, Solana Devnet | Helius enhanced transactions | `HELIUS_API_KEY` | parsed transfers and a type hint |
| Solana, Solana Devnet | plain RPC (`getSignaturesForAddress` + `getTransaction`) | none (`SOLANA_RPC_URL`) | slow: 15 transactions a page, balance deltas |
| Arc Testnet | none | | listed as `unsupported` |

Reads are paced per provider (Etherscan 4 calls a second), each provider page
is cached 60 s, historical prices for good (recent misses are retried).

**Kinds**: the protocol the transaction touched decides first: the called
contract, then the programs invoked, then the transfers' counterparties are
looked up in Kletia's registry (`VENUE_CONTRACTS`, the yield venues' targets
and receipt tokens, the perps deployments, CoW Protocol and the Jupiter
order programs, Jupiter and its DEX programs, and Polymarket's exchanges on
Polygon for `prediction`). Bridges give `bridge-out` / `bridge-in` (or `swap`
when a different token comes back on the same network), DEXes and
aggregators `swap`, lending and savings venues `deposit` / `withdraw` by
the receipt token and `borrow` / `repay` by the method, liquid staking
`stake` / `unstake`, perps venues `perp`, order programs `order`.
Otherwise one token out and another in is a `swap`, a plain or token
transfer out a `send`, in a `receive`; an approval that moves nothing is
`approve`, a reverted transaction `failed`, any other call `contract-call`.
A transaction the wallet only paid the fee for (a relayer) has no legs.

**Values**: legs of listed assets and gas assets are priced at the
transaction's hour (DefiLlama `batchHistorical`, within 6 hours;
`COINGECKO_API_KEY` adds CoinGecko for gas assets it misses). Unlisted tokens
are never priced from a provider's symbol (it may be spam): `usdAtTime: null`
with the reason.

**Filters**: `network`, `kind`, `asset` (symbol or address / mint),
`protocol` (id or label), `from` / `to` (ISO), `kletiaOnly`, `limit` (1 to
100, default 50). **Paging**: pass `cursor` back; it is tied to the same
wallets and filters (400 otherwise) and holds each account's own position,
so the merged order never skips a row. An account whose read failed keeps
its position for the next page.

**Kletia links**: a transaction whose hash a Kletia intent step claimed
carries `kletiaIntentId` and the latest `kletiaReceiptId` only when the
caller may see that intent: the API key that owns it, or a wallet session
whose wallets it was planned for.

`GET /v1/data/transactions/<network>:<hash>` returns one transaction of the
wallets (Solana by signature; EVM by reading the address's history at the
transaction's block), 404 `DATA_TRANSACTION_NOT_FOUND` when none involves
them.

### PnL

`GET /v1/data/pnl?period=24h|7d|30d|all` is a FIFO cost-basis **estimate**
over the newest history (three pages of 100; a tracked set adds its cached
transactions):

- acquisitions: tokens received from outside the set and the incoming side
  of swaps and order fills, at their value at the time;
- disposals: tokens sent outside the set, the outgoing side of swaps and
  order fills, and the fees paid, each taking the oldest lots first;
- moves between the set's own wallets, bridges, deposits, withdrawals,
  staking, loans and perps or prediction collateral keep their lots.

Assets pool across networks by their group (USDC on Base and Solana is one
pool). Per asset: open quantity, cost of the open lots, realized in the
period, unrealized (open lots at the portfolio's price now). A missing
price at the time, or a disposal larger than the read history acquired
(bought before it), makes that part `null` with the reason, and
`totals.complete` false.

### Tracking and snapshots

On the desk, a signed-in wallet opts its wallets into tracking
(`POST /v1/data/tracking`). Every wallet of the set is proven by its own
wallet sign-in (SIWE or SIWS, the developer account session): the session's
wallet, plus up to three other wallets whose session tokens (signed in at the
same site) are sent in `proofs`. A set holds at most two EVM and two Solana
wallets, and a wallet belongs to one set (409 `DATA_WALLET_TRACKED`).
`DELETE` deletes the set with its snapshots and cache when its creator calls
it; another member only leaves.

The snapshot job (every 10 minutes on long-running hosts, one runner across
replicas with Postgres through an advisory lock, like the automation
evaluator) reads each tracked set's portfolio at most once an hour and keeps
the hour's first reading (8 days) and the day's latest (for good). A failed
read writes nothing; writing a bucket twice never adds a point.
`GET /v1/data/snapshots?range=` returns hourly points for `24h` and `7d`,
daily for `30d` and `all`, with the change from the first to the last point.
Untracked wallets answer an empty series with `tracked: false`. With
`KLETIA_DATABASE_URL` the sets, points and cache live in Postgres
(`kletia_data_tracking`, `kletia_data_tracking_members`,
`kletia_data_snapshots`, `kletia_data_transactions`); without it in memory.

### Summary

`GET /v1/data/summary` folds the portfolio, perps, the newest history and
its PnL into one object for an assistant: totals, the five largest slices by
network and asset, the five largest positions, open perps and their
unrealized PnL, risk flags (`LOW_HEALTH`, `LIQUIDATABLE`,
`PERP_NEAR_LIQUIDATION` within 10 % of the liquidation price,
`CONCENTRATION` above 80 %, `UNPRICED`, `UNREAD`, `HISTORY_INCOMPLETE`),
activity counts for 24 hours, 7 and 30 days by kind, the PnL estimates and
every source used.

### Service module

Other packages call the same reads as typed functions from
`apps/api/src/platform/data/index.ts`:

```ts
import { walletScope, sessionScope, summary, transactions, transaction, pnl, positions, snapshots } from "…/platform/data/index.js";

const scope = walletScope({ evm: "0x…", solana: "9WzD…" }, authContextOrNull); // public reads
const tracked = await sessionScope({ walletKind: "evm", address: "0x…" });      // a tracked set, or null

await summary(scope);                                   // DataSummary
await transactions(scope, { kind: "swap", limit: 20 }); // DataTransactionPage
await transaction(scope, "base:0x…");                   // DataTransaction
await pnl(scope, { period: "30d" });                    // DataPnl
await positions(scope, { extras: true });               // DataPositions with extras
await snapshots(scope, { range: "7d" });                // DataSnapshotSeries
```

### Export

CSV follows RFC 4180: a header row, CRLF line ends, cells quoted when they
hold a comma, quote or line break. Unknown values are empty cells. Text cells
starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` so a
spreadsheet never runs them as formulas. The SDK's `data.exportCsv` and the
desk build the same file locally with `@kletia/core`'s `dataHoldingsCsv`,
`dataPositionsCsv`, `dataHistoryCsv` and `dataTransactionsCsv` (one row per
leg; a transaction without legs is one row).

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
// With a key (publishable keys too):
const keyed = new KletiaClient({ publishableKey: "kl_pub_…" });
const page = await keyed.data.transactions({ evm: "0x…", kind: "swap", limit: 20 });
const older = await keyed.data.transactions({ evm: "0x…", kind: "swap", cursor: page.cursor ?? undefined });
const pnl = await keyed.data.pnl({ evm: "0x…", period: "30d" });
const summary = await keyed.data.summary({ evm: "0x…", solana: "9WzD…" });
// Server side, with a secret key:
const history = await new KletiaClient({ apiKey: process.env.KLETIA_API_KEY }).data.history({ limit: 20 });
```

## Route statistics

`routes` in `GET /v1/data/markets/status` is `null` (with `routesReason`)
until the deployment installs a source with `configureRouteStatsSource` (the
engine's per-venue quote statistics: attempts, latency, failure rate and
circuit-breaker state per network pair).
