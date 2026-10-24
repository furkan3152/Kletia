# Predictions

`/v1/predictions` lists prediction markets, quotes YES/NO (or named) outcome
shares and builds orders for the user's own wallet. Kletia never signs:
prepare returns unsigned approvals and EIP-712 typed data, and the only thing
Kletia sends to the venue is an order the user already signed. The desk's
Predict view (`/app/predict`, a sub-tab of Trade) is built on the same routes.

A share pays 1 pUSD if its outcome wins and 0 if it loses. Its price (0 to
1) is the market's implied probability, not a guarantee: **you can lose the
whole stake.** Every quote says the most you can lose before it says the
payout.

| Venue | Network | Status |
| --- | --- | --- |
| Polymarket | Polygon PoS | Live: markets, books, quotes, orders from a plain wallet (EOA), positions, redemption |
| Limitless Exchange | Base | Not added (below) |
| Kalshi | (custodial) | Not integrated: it requires KYC and holds funds in custodial accounts, which a non-custodial product cannot offer |

Polymarket is in the protocol registry with category `prediction` and
surface `service` (`GET /v1/protocols`); it is not an intent-engine adapter.

## Routes

| Route | What it does |
| --- | --- |
| `GET /v1/predictions/markets` | Open markets that take orders: `?q=` (search), `?category=` (politics, sports, crypto, economy, finance, tech, geopolitics), `?sort=volume` (busiest today) or `ending`. Cached 15 s. Lists the venues too, with Limitless's `disabledReason`. |
| `GET /v1/predictions/markets/{id}` | One market (Gamma id, or the condition id positions carry): each outcome's order book (best first) and a week of prices, plus Polymarket's location note and terms link. |
| `GET /v1/predictions/positions?account=` | Positions of a Polygon account (`eip155:137:0x…`), or `?holder=0x…` for a Polymarket Deposit, Proxy or Safe wallet (read only). `tradable` says whether Kletia can trade and redeem for it. |
| `POST /v1/predictions/quote` | Implied probability, average and worst price, shares, the most you can lose, payout and profit if the outcome wins, fees. |
| `POST /v1/predictions/prepare` | The steps for the wallet, in order, valid 120 s, and the relay `ticket`. |
| `POST /v1/predictions/session` | `{ account }`: the sign-in to sign; `{ account, auth }`: the sealed venue session. |
| `POST /v1/predictions/submit` | Relays the signed order (with `session`, or `auth` to sign in on the way). |
| `POST /v1/predictions/orders` | Open orders of the session's account. |
| `POST /v1/predictions/orders/cancel` | Cancels one resting order. |
| `POST /v1/predictions/redeem` | Unsigned redemption of a resolved market's shares. |

A request (`PredictionRequest` in `@kletia/core`):

```json
{ "venue": "polymarket", "marketId": "666861", "outcome": "Yes", "side": "buy",
  "orderType": "market", "amountUsd": "20", "slippageBps": 200, "account": "eip155:137:0x…" }
```

`side` is `buy` (spend `amountUsd`, fees included) or `sell` (`shares`).
`orderType` is `market` (fill now, Fill-And-Kill: the unfilled rest is
cancelled, never left open) or `limit` (rests on the book at `limitPrice`,
Good-Til-Cancelled).

## Guards (fail closed)

Quote and prepare refuse, before anything is built:

- a venue Kletia did not add (`PREDICTION_VENUE_DISABLED`);
- a rule book that disables prediction markets or the venue
  (`PREDICTION_POLICY_DENIED`), or a stake above its cap
  (`PREDICTION_STAKE_TOO_HIGH`);
- a closed, resolved or paused market (`PREDICTION_MARKET_CLOSED`), an
  outcome the market does not list (`PREDICTION_OUTCOME_UNKNOWN`);
- a market whose version, outcome ids, tick size or fee schedule cannot be
  read, an empty or stale (over 60 s) book (`PREDICTION_PRICE_UNAVAILABLE`);
- an order below the market's minimum shares (`PREDICTION_ORDER_TOO_SMALL`);
- a smart-contract wallet (`PREDICTION_ACCOUNT_UNSUPPORTED`), too little
  pUSD (and USDC.e) or too few shares (`PREDICTION_BALANCE_TOO_LOW`,
  `PREDICTION_POSITION_NOT_FOUND`).

The math (`@kletia/core` `predictions.ts`):

- **Fees** follow the market's schedule: `fee = shares · rate · (p(1 − p))^exponent`,
  charged to the taker (docs "Fees"; geopolitics markets are fee-free). A buy
  pays it on top of the fill, a sell from the proceeds.
- **A market buy is all-in.** The signed spend (`makerAmount`) leaves room for
  the fee at the costliest price the order may fill at, so spend plus fee never
  exceeds the stake. `maxLossUsd` is that bound.
- **Signed amounts** use the docs' tick-size rounding in exact integers
  (`polymarketOrderAmounts`), matching `@polymarket/clob-client-v2` 1.2.0
  `getMarketOrderRawAmounts` / `getOrderRawAmounts` (tests). The worst price
  is on the tick grid: rounded up for a buy, down for a sell.

## Accounts and approvals

Kletia trades Polymarket only from a **plain wallet (EOA) that signs its own
orders** (`signatureType` 0, maker = signer = the account). Polymarket's own
accounts are smart wallets: Deposit Wallets (every account created since May
4, 2026), and legacy Proxy and Safe wallets. Their positions are read; their
trading needs Polymarket's relayer and wrapped (ERC-7739) signatures that
Kletia does not build, so it says "not supported" instead. Polymarket's docs
describe EOA trading for wallets the venue allows; an EOA it does not accept
gets the CLOB's own refusal, shown as `PREDICTION_RELAY_REJECTED`.

Collateral is **pUSD** (Polymarket USD, 6 decimals, backed by USDC). When the
wallet's pUSD does not cover the stake but USDC.e does, prepare adds an exact
USDC.e approval to CollateralOnramp and a `wrap` (1:1). Native USDC is not
wrapped by the onramp: swap it to USDC.e first.

Prepare checks every allowance and adds only what is missing:

| Order | Approval | Kind |
| --- | --- | --- |
| Buy, v1 market | pUSD `approve(CTF Exchange or Neg Risk CTF Exchange, stake)` | Exact amount |
| Buy, v1 negative-risk market | also pUSD `approve(Neg Risk Adapter, stake)` and ConditionalTokens `setApprovalForAll(Neg Risk Adapter)` (docs: the CLOB checks both) | Exact / operator |
| Buy, v2 market | pUSD `approve(ExchangeV3, stake)` | Exact amount |
| Sell, v1 market | ConditionalTokens `setApprovalForAll(exchange)` (and the Neg Risk Adapter on negative-risk markets) | Operator |
| Sell, v2 market | PositionManager `setApprovalForAll(ExchangeV3)` | Operator |
| Redeem, v1 | ConditionalTokens `setApprovalForAll(collateral adapter)` | Operator |
| Redeem, v2 | PositionManager `setApprovalForAll(Router)` | Operator |

ERC-1155 has no amount for an operator: `setApprovalForAll` lets that
contract move every share on that ledger until it is revoked. Each such step
carries a `disclosure` that says so, and the desk shows it before signing.

## Signing and the relay

Orders are EIP-712 `Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)`
under the domain `{ "Polymarket CTF Exchange", version, 137, exchange }`:
version `"2"` for v1 markets (CTF Exchange V2 or its neg-risk twin), `"3"` for
Protocol V2 markets (ExchangeV3). `expiration` (0) and the order type travel
unsigned. Kletia's order hashes equal those of Polymarket's SDK builder
(tests), and each exchange's `eip712Domain()` read on Polygon returns the
pinned domain.

The CLOB needs **L2 credentials** for each order. The wallet signs
`ClobAuth` (domain `ClobAuthDomain`, version 1, chain 137; no funds move);
Kletia checks it recovers to the account, has the CLOB derive (or create)
the account's API key, and returns the credentials **sealed** (AES-256-GCM
under `KLETIA_PLATFORM_SECRET`, bound to that account) as `session`. Kletia
stores nothing and never logs it; the desk keeps it in memory for the tab
(8 hours at most). The credentials place and cancel orders; they cannot move
funds. Without a platform secret, sessions and relay tickets are unavailable
(`PREDICTION_SESSION_UNAVAILABLE`).

`POST /v1/predictions/submit` relays only an order prepare built: the
`ticket` is Kletia's MAC over the order's typed-data hash, its unsigned fields
and its expiry, so a changed amount, price, token or exchange is refused, as
is an expired one or a signature that does not recover to the account
(`PREDICTION_SIGNATURE_INVALID`). The rule book is read again at submit. It
refreshes the CLOB's balance and allowance cache, then posts the order with
L2 headers (HMAC-SHA256 as the SDK's `buildPolyHmacSignature`, tests). The
venue's answer comes back as it is: `matched`, `live`, `delayed` or
`unmatched`, or its refusal (`PREDICTION_RELAY_REJECTED`).

## Location rules

Polymarket restricts trading in some places (its list includes the United
States, the United Kingdom, France, Germany and others; some are close-only)
and checks the location of each request itself. Kletia never works around
that:

- the desk asks `polymarket.com/api/geoblock` **from the person's browser**
  (the check answers for the requesting IP) and turns buying off when it
  says restricted or does not answer;
- the relay asks the same endpoint for its own host and does not send a buy
  while it reports restricted (`PREDICTION_GEOBLOCKED`); sells and cancels
  (closing) go through, and the CLOB decides;
- a CLOB refusal for location reasons is reported plainly as
  `PREDICTION_GEOBLOCKED`, never retried elsewhere.

Polymarket's terms (`https://polymarket.com/tos`) are linked beside every
ticket.

## Rule Book

```json
{ "schema": "kletia.policy/v1", "predictions": { "enabled": true, "maxStakeUsd": "50", "venues": ["polymarket"] } }
```

Without a rule book (and for the desk without a key) prediction markets are
enabled on every live venue with a 10,000 USD cap per order
(`PREDICTION_LIMITS.defaultMaxStakeUsd`); a rule book may set 1 to 1,000,000.
**Agent keys have prediction markets disabled** unless their rule book sets
`predictions.enabled: true`. The chain combines as for perps: every level
must enable it and be `live`, the lowest `maxStakeUsd` wins, and the venues
are those every level's `predictions.venues` and `protocols.allow` / `deny`
allow. A sub-agent may enable them only within its parent's chain
(`checkSubagentPolicy`, [sub-agents](subagents.md)).

## Sentences

The sentence reader hands prediction sentences to this surface (status
`handoff`, [clarify](clarify.md#hand-offs)); nothing is planned:

| Sentence | Hand-off |
| --- | --- |
| what are the odds of X? / how likely is X? / what does polymarket say about X? | `search` with the words: Predict opens the market search |
| bet $20 on yes for X / buy 50 USDC of NO on X / wager 10 usdc on no in X / buy yes on X for $25 | `buy` with the market the person picked |
| sell my trump shares / sell all my no shares on X / sell 50 yes shares of X | `sell` with the words: Predict lists matching positions to pick from |

Market words are fuzzy, so the reader searches Polymarket and **never
guesses a market**: one open market matching every word is shown as a chip;
several (or none matching every word) are asked as a question with up to
eight options; none is refused (`PREDICTION_MARKET_NOT_FOUND`). A missing
outcome or stake is asked. A stake above the rule book's cap is refused. A
sentence whose market words carry a condition, time, negation or hedge ("if",
"unless", "later", "not", "or", ...) is refused rather than read into a
market's name; Predict's search takes any words.

## MCP

`search_prediction_markets` (words, category or sort) and
`plan_prediction_order` (the quote and the unsigned steps' titles for a
plain wallet; it never submits: the person signs in their wallet). See
[MCP](mcp.md).

## Limitless Exchange (not added)

Limitless documents its API and contracts (Base; docs.limitless.exchange).
Its order relay authenticates every request with a per-user scoped API
token (HMAC) that is issued once, after a Privy sign-in on
limitless.exchange; Kletia would have to hold that secret for the user, and
markets settle on three exchange generations per market type that Kletia
has not verified. It is listed with that reason (`disabledReason`) and
nothing is built for it.

## Configuration

Keyless public endpoints; each base URL can be overridden (https only):

| Variable | Default |
| --- | --- |
| `POLYMARKET_GAMMA_URL` | `https://gamma-api.polymarket.com` |
| `POLYMARKET_CLOB_URL` | `https://clob.polymarket.com` |
| `POLYMARKET_DATA_URL` | `https://data-api.polymarket.com` |
| `POLYMARKET_GEOBLOCK_URL` | `https://polymarket.com/api/geoblock` |
| `POLYGON_RPC_URL` | keyless public RPCs (balances, allowances, wallet code) |

No builder or relayer key is needed: Kletia attaches no builder code and
does not use Polymarket's gasless relayer (Deposit Wallets). Sessions and
relay tickets need `KLETIA_PLATFORM_SECRET`.

## Pinned contracts (Polygon, chain 137)

From docs.polymarket.com/resources/contracts, matching `MATIC_CONTRACTS` of
`@polymarket/clob-client-v2` 1.2.0; read back on Polygon on 2026-10-24 (code
present, the selectors Kletia encodes found in the code, and each exchange's
ERC-5267 `eip712Domain()` returning `Polymarket CTF Exchange` with the pinned
version and address):

| Contract | Address |
| --- | --- |
| pUSD (CollateralToken proxy) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CollateralOnramp | `0x93070a847efEf7F70739046A929D47a521F5B8ee` |
| ConditionalTokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| CTF Exchange (V2, domain "2") | `0xE111180000d2663C0091e4f400237545B87B996B` |
| Neg Risk CTF Exchange (domain "2") | `0xe2222d279d744050d28e00520010520000310F59` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| ExchangeV3 (Protocol V2, domain "3") | `0xe3333700cA9d93003F00f0F71f8515005F6c00Aa` |
| PositionManager | `0x006F54F7f9A22e0000CC2AB60031000000ae9fEF` |
| Router | `0x12121212006e4CD160D18e3f00711DA5c3372600` |
| CtfCollateralAdapter | `0xAdA100Db00Ca00073811820692005400218FcE1f` |
| NegRiskCtfCollateralAdapter | `0xadA2005600Dec949baf300f4C6120000bDB6eAab` |
