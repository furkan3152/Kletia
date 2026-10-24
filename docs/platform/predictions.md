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
| Polymarket | Polygon PoS | Live: markets, books, quotes, orders from the user's own Polymarket wallet (Safe or Deposit Wallet, found from their EVM wallet) or a plain wallet, positions, open orders, redemption, deposits and withdrawals |
| Limitless Exchange | Base | Not added (below) |
| Kalshi | (custodial) | Not integrated: it requires KYC and holds funds in custodial accounts, which a non-custodial product cannot offer |

Polymarket is in the protocol registry with category `prediction` and
surface `service` (`GET /v1/protocols`); it is not an intent-engine adapter.

## Routes

| Route | What it does |
| --- | --- |
| `GET /v1/predictions/markets` | Open markets that take orders: `?q=` (search), `?category=` (politics, sports, crypto, economy, finance, tech, geopolitics), `?sort=volume` (busiest today) or `ending`. Cached 15 s. Lists the venues too, with Limitless's `disabledReason`. |
| `GET /v1/predictions/markets/{id}` | One market (Gamma id, or the condition id positions carry): each outcome's order book (best first) and a week of prices, plus Polymarket's location note and terms link. |
| `GET /v1/predictions/wallets?account=` | The account's Polymarket wallets ([below](#your-polymarket-wallet)): derived, checked on Polygon, with pUSD and USDC.e balances, whether Kletia trades each, and the moves it builds. |
| `GET /v1/predictions/positions?account=` | Positions of a Polygon account (`eip155:137:0x…`); `&wallet=0x…` for its Polymarket wallet (verified as the account's), or `?holder=0x…` for any address (read only). `tradable` says whether Kletia can trade and redeem for it. |
| `POST /v1/predictions/quote` | Implied probability, average and worst price, shares, the most you can lose, payout and profit if the outcome wins, fees. |
| `POST /v1/predictions/prepare` | The steps for the wallet, in order, valid 120 s, and the relay `ticket`. |
| `POST /v1/predictions/session` | `{ account }`: the sign-in to sign; `{ account, auth }`: the sealed venue session. |
| `POST /v1/predictions/submit` | Relays the signed order (with `session`, or `auth` to sign in on the way). |
| `POST /v1/predictions/orders` | Open orders of the session's account (`wallet`: only those its Polymarket wallet makes). |
| `POST /v1/predictions/orders/cancel` | Cancels one resting order. |
| `POST /v1/predictions/redeem` | Unsigned redemption of a resolved market's shares (`wallet`: those the account's Safe holds). |
| `POST /v1/predictions/wallet` | Unsigned moves between the account and its Polymarket wallet: `deposit`, `withdraw`, `wrap`. |

A request (`PredictionRequest` in `@kletia/core`):

```json
{ "venue": "polymarket", "marketId": "666861", "outcome": "Yes", "side": "buy",
  "orderType": "market", "amountUsd": "20", "slippageBps": 200, "account": "eip155:137:0x…",
  "wallet": "0x… (the account's Polymarket wallet; omitted: the account trades for itself)" }
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
- a `wallet` that is not the account's Safe or Deposit Wallet on Polygon
  now (`PREDICTION_WALLET_NOT_FOUND`), one not deployed yet or a Deposit
  Wallet step only Polymarket's relayer runs
  (`PREDICTION_WALLET_SETUP_REQUIRED`), a Proxy wallet or, with no `wallet`,
  an account that is a smart contract (`PREDICTION_ACCOUNT_UNSUPPORTED`);
- too little pUSD (and USDC.e) or too few shares in the wallet that trades
  (`PREDICTION_BALANCE_TOO_LOW`, `PREDICTION_POSITION_NOT_FOUND`).

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

## Your Polymarket wallet

polymarket.com does not trade from the wallet a person connects: it creates
an account wallet for it, and the funds and shares live there. Kletia finds
that wallet from the connected EVM wallet and trades from it, so the desk
shows what polymarket.com shows. Sources: docs.polymarket.com
"Wallets and Authentication" and "Contracts" (Wallet Factory Contracts),
`@polymarket/client` 0.14.0 (`walletDerivation`, wallet-type detection),
`@polymarket/builder-relayer-client` 0.0.10 (`derive.js`, Safe transaction
builder), `@polymarket/clob-client-v2` 1.2.0 (signature types, order and
ERC-7739 signature builders), and the exchanges' `Signatures.sol`
(Polymarket/ctf-exchange-v2), all read on 2026-10-24.

| Kind | Who has it | Address (CREATE2 of the owner EOA) | Kletia |
| --- | --- | --- | --- |
| Deposit Wallet (`signatureType` 3, POLY_1271) | Every account wallet deployed since May 4, 2026 | Deposit Wallet factory `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07`, salt `keccak256(abi.encode(factory, bytes32(owner)))`, Solady ERC-1967 beacon proxy of beacon `0x7A18…fc3a` (since June 29, 2026) or UUPS proxy of `0x58CA…B1eB` (before) | Trades (orders); its own transactions run through Polymarket's relayer, so approvals, wrapping, withdrawals and redemption stay on polymarket.com |
| Safe (`signatureType` 2, POLY_GNOSIS_SAFE) | Browser-wallet (MetaMask, Rabby) accounts before May 2026 | Safe factory `0xaacF…541b`, salt `keccak256(abi.encode(owner))`, init code hash `0x2bce…cecf` | Trades, approves, wraps, redeems and withdraws (the owner sends the Safe's `execTransaction`) |
| Proxy (`signatureType` 1, POLY_PROXY) | Email and Google sign-ins (Magic) before May 2026 | Proxy factory `0xaB45…4052`, salt `keccak256(abi.encodePacked(owner))`, EIP-1167 clone of `0x44e9…EB4f` (init code hash `0xd21d…0a00b`) | Read only: the owner key is Magic's, so its orders are signed on polymarket.com |

**Discovery** (`GET /v1/predictions/wallets`, `polymarketWalletsOf`)
derives the four addresses, reads their code on Polygon and keeps a wallet
only when it is the owner's now: a Safe's `getOwners()` lists the EOA, a
Deposit Wallet's `owner()` is the EOA, a Proxy address holds exactly the
factory's clone code. The derivation is the one the exchanges themselves
check (`getSafeWalletAddress`, `getProxyWalletAddress`); tests hold it to
real pairs read on Polygon and to those on-chain answers. Polymarket's public
profile (`gamma-api.polymarket.com/public-profile?address=`) is a
cross-check: it marks the wallet polymarket.com shows (`onProfile`, picked
first) and never adds one; a profile wallet Kletia cannot verify is named
in `notes` and not used. Anything unread is an error (`RPC_UNAVAILABLE`),
never "no wallet". A Safe that needs more than one signature is read only.

**Trading from a Safe** is what polymarket.com does for Safe accounts: the
order's maker is the Safe, its signer the owner EOA, `signatureType` 2; the
EOA signs the order itself, and signs in to the CLOB (ClobAuth) for its L2
credentials, as `@polymarket/clob-client-v2` does with a funder address.
Approvals, a USDC.e wrap and redemption are calls the Safe makes: each step
is the Safe's `execTransaction(to, 0, data, CALL, 0, 0, 0, 0x0, 0x0,
signature)` sent by the owner, with Safe 1.3.0's pre-validated owner
signature (r = owner, s = 0, v = 1: valid because the owner itself sends
it), so nothing else is signed and the owner pays the POL gas. Each step
carries `safeTx` (the Safe, its nonce, the EIP-712 SafeTx hash, equal to the
Safe's own `getTransactionHash`).

**Trading from a Deposit Wallet**: maker = signer = the wallet,
`signatureType` 3. The EOA signs the ERC-7739 `TypedDataSign` wrapper of
the order (domain: the exchange's; `contents`: the order; the wallet's own
domain "DepositWallet", "1"), and the relay packs the signature as the SDK's
`buildOrderSignature` (signature, exchange domain separator, order struct
hash, the `Order(...)` type string and its length). Prepare refuses
(`PREDICTION_WALLET_SETUP_REQUIRED`) when the wallet still lacks an
approval or pUSD: those transactions run only through Polymarket's relayer.

**The relay's guard** for wallet orders: the ticket and the signature (it
must recover to the account) as for any order, then a fresh read on
Polygon: the maker is the account's Safe (derived from it, deployed,
`getOwners()` lists it) or Deposit Wallet (derived, deployed, `owner()`),
and a Deposit Wallet's own `isValidSignature(orderHash, packed signature)`
returns the ERC-1271 magic value, as the exchange checks it. Any read that
fails refuses. `balance-allowance/update` and the order carry the wallet's
signature type.

**Wallet moves** (`POST /v1/predictions/wallet`): `deposit` is a plain pUSD
or USDC.e `transfer` from the EOA to its verified Polymarket wallet (any
kind); `withdraw` makes the Safe `transfer` pUSD or USDC.e to its owner and
to no other address; `wrap` approves CollateralOnramp exactly and wraps the
Safe's USDC.e into pUSD. A Safe or Deposit Wallet that is not deployed yet
is created on polymarket.com (it does that for free when the EVM wallet
signs in); Kletia does not deploy one, since new accounts get a Deposit
Wallet, which only Polymarket's relayer deploys.

**Gasless relayer (not used).** Polymarket's relayer
(`relayer-v2.polymarket.com/submit`, docs relayer-openapi) accepts only
requests authenticated with Builder API keys (`POLY_BUILDER_*`, a builder
account's secret) or Relayer API keys that belong to the user's own
address. Kletia would have to hold a builder secret for its users, so it
sends Safe calls from the owner instead (it pays POL gas) and leaves
Deposit Wallet transactions to polymarket.com. An owner who wants gasless
moves would add builder credentials (`POLYMARKET_BUILDER_API_KEY`,
`POLYMARKET_BUILDER_SECRET`, `POLYMARKET_BUILDER_PASSPHRASE`) and the
relayer path; this release reads none of them.

A plain wallet (no code) can still trade for itself (`signatureType` 0,
maker = signer = the account). Polymarket's docs describe EOA trading for
allowlisted wallets; an EOA it does not accept gets the CLOB's own refusal,
shown as `PREDICTION_RELAY_REJECTED`.

## Approvals

Collateral is **pUSD** (Polymarket USD, 6 decimals, backed by USDC). When the
trading wallet's pUSD does not cover the stake but USDC.e does, prepare adds an exact
USDC.e approval to CollateralOnramp and a `wrap` (1:1). Native USDC is not
wrapped by the onramp: swap it to USDC.e first.

Prepare checks every allowance of the wallet that trades and adds only what
is missing (for a Safe, as its `execTransaction` calls):

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

For a Safe or Deposit Wallet order the session is still the owner EOA's
(it signs in; the CLOB keys credentials to the signer).

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
`plan_prediction_order` (the quote and the unsigned steps' titles, from the
user's Polymarket wallet with `wallet` or a plain wallet; it never submits:
the person signs in their wallet). See [MCP](mcp.md).

## Desk, data and assistant

The Predict view looks up the connected EVM wallet's Polymarket wallets
first and trades from the one polymarket.com shows (a pick when there are
several). It shows that wallet's pUSD and USDC.e, its positions and its open
orders (after a sign-in that moves no funds), the moves Kletia builds for
it, and on the ticket "Trades from: Your Polymarket wallet 0x…ab12, owned by
0x…cd34". A Proxy wallet is shown read only, with why.

`GET /v1/data/positions?extras=true` reads the positions of each EVM wallet
and of each Polymarket wallet found for it (`predictions` rows carry
`holderKind`; `predictionWallets` lists the wallets read). History labels a
Polygon transaction whose counterparty is the set's own Polymarket wallet as
"Your Polymarket wallet" (a call through a Safe is a prediction-market
transaction). The assistant's prediction answers read the same extras and
say which wallets they read.

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
does not use Polymarket's gasless relayer ([above](#your-polymarket-wallet)).
Wallet discovery reads Gamma's public profile (`POLYMARKET_GAMMA_URL`).
Sessions and relay tickets need `KLETIA_PLATFORM_SECRET`.

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
| Deposit Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` |
| Deposit Wallet Beacon | `0x7A18EDfe055488A3128f01F563e5B479D92ffc3a` |
| Deposit Wallet implementation (UUPS wallets) | `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB` |
| Gnosis Safe Factory ("Polymarket Contract Proxy Factory") | `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b` |
| Polymarket Proxy Factory | `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052` |
| Proxy wallet implementation | `0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f` |

The wallet factories come from the same docs page (Wallet Factory
Contracts) and `@polymarket/client` 0.14.0; the Proxy implementation and the
Deposit Wallet implementation from that SDK's `walletDerivation`. Read back
on Polygon on 2026-10-24: real Safes (Safe 1.3.0, threshold 1), Deposit
Wallets (beacon and UUPS) and Proxy clones sit at the derived addresses of
their owners, and CTF Exchange `getSafeWalletAddress` / `getProxyWalletAddress`
and the Safe factory's `computeProxyAddress` return the same addresses
(fixtures/predictions/polymarket-wallets.json).
