# Perps

`/v1/perps` quotes and builds leveraged long and short positions on
perpetual futures venues. Kletia never signs: prepare returns unsigned
transactions or EIP-712 typed data for the user's own wallet, and the only
thing Kletia sends anywhere is a Hyperliquid action the user already signed.
The desk's Perps view (`/app/perps`) is built on the same routes.

| Venue | Network | Signing | Status |
| --- | --- | --- | --- |
| GMX v2 | Arbitrum One | EVM transactions (USDC approval, ExchangeRouter multicall) | Live: ETH, BTC, SOL markets with USDC collateral |
| Hyperliquid | Hyperliquid L1, deposits on Arbitrum One | Bridge2 USDC deposit (EVM transaction), then EIP-712 L1 actions | Live: ETH, BTC, SOL |
| Drift v2 | Solana | Solana transactions | Read-only: positions are read, nothing is prepared (see below) |

All three are in the protocol registry with category `perps` and surface
`service` (`GET /v1/protocols`); they are not intent-engine adapters.

## Routes

| Route | What it does |
| --- | --- |
| `GET /v1/perps/markets` | Venues, and their markets with mark price, hourly funding (positive: the side pays), open interest, maintenance margin, fee and leverage cap. Cached 10 s. A venue that cannot be read, or whose price is older than 120 s, lists no markets and appears under `unavailable`. |
| `GET /v1/perps/positions?account=<CAIP-10>` | EVM accounts: GMX v2 (USDC markets) and Hyperliquid. Solana accounts: Drift v2. PnL is the price move at the mark before closing fees and unsettled funding. |
| `POST /v1/perps/quote` | Expected entry, acceptable (worst) price, estimated liquidation price, fees and one hour of funding. Without `venue`, every venue is scored and the cheapest eligible one is `best`. |
| `POST /v1/perps/prepare` | The steps for the wallet, in order, valid 60 s. |
| `POST /v1/perps/submit` | Relays a Hyperliquid action the account signed. |

A request (`PerpsRequest` in `@kletia/core`):

```json
{ "action": "open", "symbol": "ETH", "side": "long", "venue": "gmx-v2",
  "collateral": { "asset": "USDC", "amount": "100" }, "leverage": 5,
  "slippageBps": 50, "account": "eip155:42161:0x…" }
```

`action` is `open`, `increase`, `decrease` (needs `sizeUsd`), `close` (reads
the position) or `cancel` (Hyperliquid, with `orderId`). Give two of size,
collateral and leverage.

## Guards (fail closed)

Before anything is built, prepare and quote refuse:

- a disabled venue (`PERPS_VENUE_DISABLED`);
- a rule book that disables perps or the venue (`PERPS_POLICY_DENIED`);
- leverage above the rule book's cap or the venue's market cap
  (`PERPS_LEVERAGE_TOO_HIGH`);
- collateral below the venue's minimum (`PERPS_COLLATERAL_TOO_LOW`; a
  Hyperliquid deposit under 5 USDC would be lost, so it is never built) or
  a size below it (`AMOUNT_TOO_SMALL`);
- a market or collateral the venue does not list (`PERPS_MARKET_UNSUPPORTED`);
- a missing or stale price (`PERPS_PRICE_UNAVAILABLE`);
- decrease or close without a position (`PERPS_POSITION_NOT_FOUND`).

Every order carries a slippage bound: GMX `acceptablePrice`, a Hyperliquid
IOC limit price, a Drift limit price. The liquidation price is an estimate
from the venue's maintenance margin `m`: a position liquidates when
`collateral + side · Q · (P − entry) = m · Q · P` (the formula of the
Hyperliquid documentation; `perpsLiquidationPrice` in `@kletia/core`).

## Rule Book

```json
{ "schema": "kletia.policy/v1", "perps": { "enabled": true, "maxLeverage": 5, "venues": ["hyperliquid"] } }
```

Without a rule book (and for the desk without a key), perps are enabled on
every live venue with a 20x cap (`PERPS_LIMITS.defaultMaxLeverage`); a rule
book may set 1 to 50. **Agent keys have perps disabled** unless their rule
book sets `perps.enabled: true`. The chain combines as everywhere else: every
level must enable perps and be `live`, the lowest `maxLeverage` wins, and the
venues are those every level's `perps.venues` and `protocols.allow` /
`protocols.deny` allow. Raising `maxLeverage`, adding venues or enabling
perps loosens (it waits `amendments.delaySeconds`).

## GMX v2

Prepare returns an exact USDC approval to the GMX Router when the allowance
is short, then one ExchangeRouter `multicall` of `sendWnt` (execution fee),
`sendTokens` (collateral, increases only) and `createOrder`
(`MarketIncrease` / `MarketDecrease`, no swap path, `acceptablePrice`).
GMX keepers execute the order seconds later at the oracle price; an order
that cannot fill within its acceptable price is cancelled and the collateral
returned. The execution fee follows `GasUtils.adjustGasLimitForEstimate`
(DataStore gas settings × gas price) and is doubled; GMX refunds what the
keeper does not use. The encoding matches orders the GMX interface sent on
Arbitrum byte for byte (tests), except that Kletia sets no UI fee receiver.

Pinned addresses (`GMX_V2_ARBITRUM`, `GMX_V2_MARKETS`; gmx-synthetics
`deployments/arbitrum`, as shipped in `@gmx-io/sdk` 2.4.0), read back on
Arbitrum on 2026-10-23: ExchangeRouter `0x7dE39FF2e232A2203196788d37e234cF8F1b83f1`
(its `router()` and `dataStore()` return the pins below, and its code holds
every selector Kletia encodes), Router `0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6`,
OrderVault `0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5`, DataStore
`0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8`, Reader
`0xfA26cBb46e2614609406de08CA1Dc7f70a684184`; markets (Reader.getMarket
matches each pin): ETH/USD [ETH-USDC] `0x70d95587d40A2caf56bd97485aB3Eec10Bee6336`,
BTC/USD [WBTC.b-USDC] `0x47c031236e19d024b42f8AE6780E44A573170703`, SOL/USD
[SOL-USDC] `0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9`. Prices and funding
come from the GMX oracle keeper API (`arbitrum-api.gmxinfra.io`).

## Hyperliquid

Prepare reads the account: when its withdrawable USDC does not cover the
margin and the open fee, the first step is a USDC transfer to Bridge2
(`0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` on Arbitrum One, Hyperliquid
docs "Bridge2"), credited to the same address in about a minute
(`settleSeconds: 60`). A new position then gets `updateLeverage` (isolated,
integer leverage rounded up) and the order: one IOC limit order at the
acceptable price on the exchange's price grid, `reduceOnly` for decrease and
close. Each typed-data step carries `relay.action` and `relay.nonce`; send
them back unchanged with the wallet's signature to `POST /v1/perps/submit`.
The relay rebuilds the action from its fields, checks the nonce is within
10 minutes and that the signature recovers to the account, and only then
forwards it to `api.hyperliquid.xyz/exchange`.

Hyperliquid L1 actions are EIP-712 `Agent` messages under the domain
`{ name: "Exchange", version: "1", chainId: 1337 }` (hyperliquid-python-sdk
`utils/signing.py`). Wallets that sign typed data only for the active
network, MetaMask among them, refuse them; the desk says so before signing.

## Drift v2

Drift v2 (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`) has been halted
since the exploit of April 1, 2026: its perp markets have not filled an order
since. The relaunch runs a fork with USDT settlement whose program Kletia has
not verified. Kletia therefore keeps Drift disabled: it decodes User accounts
to show positions, lists no market while oracle prices are stale, and refuses
to prepare. The builders (initialize_user_stats, initialize_user, deposit,
place_perp_order with the remaining accounts Drift loads) follow the
v2.156.0 IDL and are tested, ready for when a verified program can be pinned.

## Reader entry point

`planPerpsIntent(input, policy?)` in `apps/api/src/platform/perps/service.ts`
takes the slots a sentence names and returns the scored, guarded request:

| Sentence | Call |
| --- | --- |
| long ETH 5x with 100 USDC | `{ market: "ETH", side: "long", collateral: "100", leverage: 5 }` |
| short SOL $200 at 3x on Drift | `{ market: "SOL", side: "short", sizeUsd: "200", leverage: 3, venue: "drift-v2" }` (refused today: venue disabled) |
| short BTC $500 with 50 USDC on Hyperliquid | `{ market: "BTC", side: "short", sizeUsd: "500", collateral: "50", venue: "hyperliquid" }` |
| close my ETH long | `{ market: "ETH", side: "long", action: "close" }` (no quote: prepare reads the position) |
| reduce my SOL short by $100 | `{ market: "SOL", side: "short", action: "decrease", sizeUsd: "100" }` |
