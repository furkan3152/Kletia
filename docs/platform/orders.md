# Native protocol orders

Orders that run without the user online, after one signature: the
protocol's own keepers or solvers fill them. Kletia builds what the wallet
signs, checks it, and relays only the owner's signature. It never signs,
never holds keys and never holds funds.

| Network | Limit order | DCA |
|---|---|---|
| Solana | Jupiter Trigger API V1 (`jupiter-trigger`) | Jupiter Recurring API V1, time-based (`jupiter-recurring`) |
| Ethereum, Arbitrum, Base | CoW Protocol EIP-712 order (`cow-protocol`) | CoW Protocol TWAP through ComposableCoW, Safe accounts only |

The three protocols are in `GET /v1/protocols` with `surface: "orders"`:
they are not executed by the intent engine.

## Where the funds are

- **Jupiter.** The sell amount moves from the wallet into an order account
  of Jupiter's program (Limit Order V2 `j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X`,
  DCA `DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M`). Only a keeper fill at
  the order's terms or the owner's cancel can move it. Jupiter's newer
  Trigger V2 keeps deposits in custodial vaults and needs a wallet sign-in;
  Kletia uses V1, which keeps them on-chain.
- **CoW Protocol.** Tokens stay in the wallet. An approval of the
  GPv2VaultRelayer (`0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`, for exactly
  the amount sold) lets only a settlement through GPv2Settlement
  (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`) at the signed terms move
  them. Addresses: docs.cow.fi, contracts reference (core and periphery).

## Flow

1. `POST /v1/orders/quote`: the plan (protocol, network, amounts) and a
   comparison with the market. Nothing is stored.
2. `POST /v1/orders/prepare`: a preparation with `steps` for the wallet.
3. The wallet runs the steps in order. The last `solana-transaction` or
   `eip712` step goes back through `POST /v1/orders/submit`.
4. `GET /v1/orders?owner=<address>[,<address>]` lists open and recent orders;
   `POST /v1/orders/{id}/cancel` prepares a cancellation, submitted the same
   way.

Request body of quote and prepare:

```json
{ "kind": "limit", "owner": "<address or CAIP-10>", "sell": "USDC", "buy": "JUP",
  "amount": "1000", "amountIn": "buy", "price": "0.8", "network": "solana" }

{ "kind": "dca", "owner": "<address>", "sell": "USDC", "buy": "SOL",
  "amount": "500", "period": "day", "count": 10 }
```

- `price` counts the other asset per one unit of the `amountIn` asset. A
  seller's minimum is rounded up and a buyer's spend down, so the order is
  never worse than the stated price.
- `network` may be left out when only one order network lists both assets;
  otherwise `422 ORDER_NETWORK_REQUIRED` names the candidates in
  `error.details.candidates`.
- `expiresAt` (limit only): ISO time or unix seconds within a year. CoW
  orders default to 30 days; Jupiter orders without it do not expire.
- DCA: `period` is `minute`, `hour`, `day`, `week`, `month` or seconds
  (60 s to one year), `count` 2 to 1,000 parts. On CoW, `price` is the least
  bought per one sold for every part; without it each part accepts at most
  10% below the quote at preparation. Jupiter Recurring orders here run
  without a price floor, so a `price` is refused there.

## Steps

| `kind` | Who runs it | Comes back to Kletia |
|---|---|---|
| `solana-transaction` | The wallet signs without sending (`solana:signTransaction`) | `signedTransaction` (base64) |
| `evm-transaction` | The wallet sends it (the CoW approval); wait for it to confirm | no |
| `eip712` | The wallet signs the typed data | `signature` |
| `safe-transaction` | The Safe executes it (TWAP create and remove, contract-owner cancels) | no (`submit: "wallet"`) |

Typed data carries integer fields as decimal strings; convert them to
integers (bigint) before handing them to a signing library.

## Submit: what is checked

Submit fails closed with `422 ORDER_SIGNATURE_MISMATCH`, and nothing is
relayed, unless:

- **Solana**: the signed transaction's message bytes hash (sha256) to the
  prepared `messageHash`, the owner is the only signer, and the owner's
  ed25519 signature verifies over those bytes. The relayed signature must
  then be the one Jupiter reports.
- **EIP-712**: the stored typed data still hashes to the prepared `digest`,
  and the signature recovers to the owner (accounts without code) or the
  owner contract's `isValidSignature` accepts it (ERC-1271). The stored
  order, not anything in the request, is what Kletia posts.

Kletia then relays exactly that: Jupiter's documented `/execute` endpoint,
or the CoW orderbook (`POST /api/v1/orders`, or `DELETE /api/v1/orders`
with the signed `OrderCancellations`). Repeating the relayed submission
returns the same result with `Idempotent-Replayed: true`; another signature
for a used preparation is `409 ORDER_PREPARATION_USED`. Preparations are
kept in memory on the instance that made them: 90 s for Jupiter (the
blockhash lifetime), 30 minutes for CoW.

Before the wallet sees a Jupiter transaction Kletia checks that the owner is
its fee payer and only signer, that it calls the order program and nothing
but ComputeBudget, System, SPL Token and Associated Token, and that its
compute budget is capped.

## TWAP needs a Safe

CoW TWAP orders are ComposableCoW conditional orders. Only a Safe whose
fallback handler is CoW's ExtensibleFallbackHandler, with ComposableCoW as
the verifier of the GPv2Settlement domain, can create them. Prepare checks
all of this on-chain and answers `422 ORDER_UNSUPPORTED` with
`error.details.reason`:

- `twap-requires-safe`: the owner is a plain account (EOA) or not a Safe.
- `safe-not-configured`: the Safe lacks the handler or the domain verifier;
  CoW Swap's TWAP setup installs both.

For a ready Safe the steps are an approval of `n x partSellAmount` and
`ComposableCoW.createWithContext` (TWAP handler, a random salt, start time
from the block-timestamp factory when the transaction lands). CoW's
watch-tower posts each part when it is due. The order id is
`cow-protocol:<network>:twap-<ComposableCoW hash>`; cancel returns
`ComposableCoW.remove(hash)` for the Safe.

## Order ids and lists

Order ids are `<protocol>:<network>:<native id>`: the Jupiter order
account, the CoW order uid, or `twap-<hash>`. Statuses are `open`,
`filled`, `cancelled`, `expired` and `unknown` (a state Kletia does not
recognise; never shown as open or filled). A protocol that cannot be read
is listed in `failures`, so its orders are unknown rather than absent.
Jupiter lists the first page of open and of past orders; CoW the newest 20
per network. Unlisted Solana tokens show their mint and the decimals Jupiter
reports; unlisted ERC-20 decimals are read on-chain.

## From a sentence

The sentence reader hands order sentences to this surface (status
`handoff`, [clarify](clarify.md#hand-offs)): "sell 1 WETH at 4000 on base",
"limit buy 1000 JUP at 0.8" (priced in USDC unless a token is named), "buy
SOL with 500 USDC over 10 days", "sell 100 USDC for SOL every day for 5 days"
(500 USDC in 5 parts) and "cancel order <id>". The input is
`planNativeOrder`'s; a pair on several networks asks the network, and the
desk opens the Orders form prefilled.

## For other packages

`apps/api/src/platform/orders/index.ts` is the stable module path:
`NativeOrderProvider` (`quote`, `prepare`, `list`, `status`, `cancel`,
`relay`), `nativeOrderProviders()`, `planNativeOrder()` and the service
functions behind the routes.

```ts
planNativeOrder({ kind: "limit", sell: "USDC", buy: "JUP", amount: "1000", amountIn: "buy", price: "0.8" });
// { protocol: "jupiter-trigger", mechanism: "limit", network: "solana", ... }
```

## Limits and configuration

- One address may quote, prepare or cancel 30 times and list 60 times a
  minute, on top of the tier limits.
- `JUPITER_API_KEY` (optional) is sent as `x-api-key` and switches to
  `https://api.jup.ag`; without it the keyless `lite-api.jup.ag` is used.
  `JUPITER_API_URL` overrides the base. A Jupiter 429 is retried briefly,
  then reported as `503 PROVIDER_RATE_LIMITED` with `Retry-After`.
- `COW_API_ORIGIN` overrides `https://api.cow.fi` (for example the barn
  staging orderbook).

Errors: `ORDER_INVALID`, `ORDER_NETWORK_REQUIRED`, `ORDER_UNSUPPORTED`,
`ORDER_NOT_FOUND`, `ORDER_NOT_CANCELLABLE`, `ORDER_PREPARATION_NOT_FOUND`,
`ORDER_PREPARATION_EXPIRED`, `ORDER_PREPARATION_USED`,
`ORDER_SIGNATURE_MISMATCH`, `ORDER_RELAY_FAILED` ([catalog](errors.md)).
