# @kletia/core

The Kletia intent specification. Zero runtime dependencies; runs in Node 20+,
browsers and edge runtimes.

```bash
npm install @kletia/core
```

## What is inside

| Module | Exports |
|---|---|
| Chains | `CHAINS` (Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS, Solana, plus Arc / Arbitrum Sepolia / Solana Devnet testnets), `NetworkKey`, `resolveChain`, `explorerTxUrl`, `sameCapitalLane` |
| Identities | CAIP-10 `formatAccountId` / `parseAccountId` / `sameAccount`, CAIP-19 `formatAssetId` / `parseAssetId`, `isEvmAddress`, `isSolanaAddress`, `isSolanaSignature`, base58 codec |
| Amounts | `toBaseUnits`, `fromBaseUnits`, `formatAmount`, `applySlippage` (exact, bigint based) |
| Registries | `ASSETS` (canonical per-network tokens), `PROTOCOLS` (venues, capabilities and executable `kinds`), `YIELD_VENUES` / `getYieldVenue` / `findYieldVenue` (pinned lending markets and vaults), `VENUE_CONTRACTS` / `venueContracts` (pinned bridge, aggregator and name-service contracts) |
| Intents | `IntentRequest`, `IntentGraph`, `IntentStep`, `StepExecutionPayload`, `TransactionRequest` |
| Lifecycle | `canTransitionStep`, `readySteps`, `deriveIntentStatus`, `topologicalOrder`, `validateIntentGraph` |
| Validation | `validateIntentRequest` |
| Events | `KletiaEventMap`, `KletiaEvent`, `createEventBus` |
| Webhooks | `signWebhookPayload`, `verifyWebhookSignature` |

## Example

```ts
import { formatAccountId, validateIntentRequest } from "@kletia/core";

const request = {
  text: "bridge 25 USDC from base to solana then swap half to JitoSOL",
  accounts: [
    formatAccountId("base", "0x1111111111111111111111111111111111111111"),
    formatAccountId("solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
  ],
};

const result = validateIntentRequest(request);
if (!result.ok) console.error(result.issues);
```

## Venues

Deposit and withdraw steps execute against a registry venue, never against an
address supplied at runtime. Venues are keyed by `(network, address)`: the same
address can be a different market on another network.

```ts
import { findYieldVenue, venueContracts } from "@kletia/core";

findYieldVenue("base", "spark-usdc")?.target;      // Morpho vault the wallet calls
venueContracts("lifi", "optimism", "diamond");     // ["0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"]
```

An action names a venue with `params.venue` (id, slug or address);
`amount: "max"` on a `withdraw` closes the whole position, and
`constraints.maxSeconds` (default 600) bounds how slow a cross-network venue
may be.

## Model

An intent compiles into an `IntentGraph`: a DAG of steps. Each step is bound
to exactly one network, one account and one protocol. Cross-network steps
settle asynchronously; a dependent step becomes `ready` only after its
dependencies settle. There is no global atomicity — every transition is backed
by on-chain or settlement-network evidence.

```
planned ─► executing ─► settling ─► completed
                │             └──► partially_completed / failed
                └──► expired / cancelled / indeterminate
```

## License

MIT
