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
| Identities | CAIP-10 `formatAccountId` / `parseAccountId` / `sameAccount` (same chain) / `sameAddressAccount` (same address on any chain of the VM), CAIP-19 `formatAssetId` / `parseAssetId`, `isEvmAddress`, `isSolanaAddress`, `isSolanaSignature`, base58 codec |
| Amounts | `toBaseUnits`, `fromBaseUnits`, `formatAmount`, `applySlippage` (exact, bigint based) |
| Registries | `ASSETS` (canonical per-network tokens), `PROTOCOLS` (venues, capabilities and executable `kinds`), `YIELD_VENUES` / `getYieldVenue` / `findYieldVenue` (pinned lending markets and vaults), `VENUE_CONTRACTS` / `venueContracts` (pinned bridge, aggregator and name-service contracts) |
| Intents | `IntentRequest`, `IntentGraph`, `IntentStep` (with `call` for custom contract steps), `StepExecutionPayload` (with `review`), `TransactionRequest` |
| Lifecycle | `canTransitionStep`, `readySteps`, `deriveIntentStatus`, `topologicalOrder`, `validateIntentGraph` |
| Validation | `validateIntentRequest`, `validateSessionCreateRequest`, `validateSessionIntentRequest`, `validateContractTestRequest`, `INTENT_ACTION_KINDS`, `MIN_MAX_SECONDS` / `MAX_MAX_SECONDS` |
| Custom contracts | `ContractDefinition` (EVM ABI actions or Solana Actions), `validateContractDefinition`, `ContractView`, `ContractReview`, `ContractStepCall`, pins and session types, `CONTRACT_LIMITS`, `FORBIDDEN_SELECTORS` / `FORBIDDEN_NAME_PREFIXES`, `BENEFICIARY_ARG_PATTERN`, `RESERVED_CONTRACT_PHRASES`, `deniedTargetReason`, `classifyAbiFunction`, `functionSelector`, `toChecksumAddress`, `contractDefinitionHash` |
| Errors | `ERROR_CATALOG` (every API error and step-failure code with status, category, retry rule and remedy), `describeError`, `resolveErrorCode`, `isRetryableError`, `errorDocsUrl`, `errorCatalogRows` |
| Events | `KletiaEventMap`, `KletiaEvent`, `createEventBus` |
| Webhooks | `signWebhookPayload`, `verifyWebhookSignature` |
| Receipts | `verifyReceipt` (offline: JCS profile, SHA-256 digest, Ed25519 over `kletia.receipt.v1:<digest>`, salted path-bound disclosures, inclusion proofs), `buildReceipt`, `buildPlanRecord`, `projectRequest`, `receiptJcs`, `intentRef`, `receiptCommitment`, `receiptKeyId`, `RECEIPT_PROFILES`, `KLETIA_RECEIPT_KEY_PINS` |
| Receipt anchors | `RpcTransport`, `readEvmAnchor`, `readSvmAnchor` (Solana version 1 transactions included), `compareAnchors`, `evmQuoteBinding`, `AnchorUnavailableError` |
| Transparency log | `merkleRoot`, `merkleAuditPath`, `verifyMerkleInclusion` (RFC 6962 / RFC 9162), `receiptLogBatchDigest` |
| Rule Book | `validatePolicy`, `canonicalPolicy`, `policyHash`, `comparePolicies` (tighten now, loosen later), `POLICY_TEMPLATES`, `evaluatePolicy` / `evaluatePolicyChain`, `buildPolicyFacts`, `narrowConstraints`, `scheduleState`, `approvalDigest`, `approvalTypedData`, `approvalMessageText`, `verifyDecisionChain`, `POLICY_RULES` |
| Intent links | `validateLinkDefinition`, `expandLink`, `blinkEligibility`, `linkDeliverFirstGuess` / `linkDeliverRescale`, `boardText`, `LINK_ID_PATTERN`, `LINK_LIMITS` |
| Asset-change preview | `IntentPreview`, `StepPreview`, `aggregatePreview`, `previewDigest`, `materialChange`, `validatePreviewAck` |
| Hashing | `sha256` / `sha256Hex` (synchronous), `base64UrlEncode` / `base64UrlDecode` |

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

## Custom contracts

Integrators can register their own EVM contract actions (and Solana Actions)
and use them in intents created with the same API key: `{ kind: "call",
network, contract: "ct_…" | "<alias>", entry: "deposit", amount }`. The
registration body is validated locally with the exact rules the API applies:

```ts
import { validateContractDefinition } from "@kletia/core";

const result = validateContractDefinition({
  vm: "evm",
  network: "base",
  address: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
  integrator: { name: "Acme Yield", website: "https://acme.example" },
  abi: [/* the deposit function and its Deposit event */],
  actions: [{
    id: "deposit",
    label: "Deposit into Acme USDC vault",
    function: "deposit(uint256,address)",
    args: ["$amount", "$account"],
    input: { token: "USDC", approval: { spender: "$self" } },
    output: { token: "$self" },
    events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
    phrases: { verbs: ["deposit"], aliases: ["acme vault"] },
    limits: { maxAmount: "25000" },
  }],
});
if (!result.ok) console.error(result.code, result.issues); // e.g. CONTRACT_FUNCTION_FORBIDDEN
```

Kletia never builds arbitrary calldata: every argument binds to a declared
source (`$amount`, `$account`, `$recipient`, `$token`, `$self`,
`$minimumOutput`, `$deadline`, `$previous.output.*`, `$param.<name>`) or a
literal. Approvals, permits, transfers, ownership, upgrades, multicall and
execute functions are refused by selector and by name; `bytes` arguments only
accept `0x`; receiver-like addresses must bind to the user; tokens, routers,
Permit2, Multicall3, precompiles and system contracts can never be targets.
See [docs/platform/contracts.md](../../docs/platform/contracts.md).

## Receipts

Every finished intent gets a signed receipt (`kletia.receipt/v1`) once its
transactions are final. Anyone can check it offline, with Web Crypto only:

```ts
import { verifyReceipt } from "@kletia/core";

const check = await verifyReceipt(receipt, {
  keys,                    // receipt keys you fetched from two origins; pinned keys are always consulted first
  intentId: "int_…",       // optional: checks that the receipt is about this intent
  requireGroups: ["steps.*.evidence"],
});
check.valid;               // signature, digest, key status and every disclosed group
check.sealed;              // groups the holder did not disclose
check.problems;            // e.g. [{ code: "DISCLOSURE_MISMATCH", path: "disclosures.steps.s1.evidence" }]
```

The payload holds a public skeleton (networks, step kinds, protocols,
assets, statuses, day) and salted SHA-256 commitments to private groups;
holders share any subset of the disclosures and the signature still verifies.
`readEvmAnchor` and `readSvmAnchor` re-read each anchor through any JSON-RPC
transport, and a source that cannot show it (pruned, `-32015`, an error)
reports `AnchorUnavailableError`, never a mismatch.

## Rule Book policies

```ts
import { evaluatePolicy, buildPolicyFacts, validatePolicy } from "@kletia/core";

const { ok, value: policy, issues, warnings } = validatePolicy({
  schema: "kletia.policy/v1",
  kinds: { allow: ["transfer", "bridge"] },
  recipients: { mode: "own" },
  accounts: { allow: ["eip155:*:0x8f3c…a21b"] },
  caps: { perStepUsd: "200", dailyUsd: "1000" },
}, { defaults: "agent" });

const facts = buildPolicyFacts(intent, { stage: "sign", stored: true });
const decision = evaluatePolicy(policy, facts, { scope: "key", defaults: "agent" });
decision.outcome;          // "allow" | "confirm" | "deny"
decision.violations;       // [{ rule: "recipients.mode", path: "steps[1].recipient", observed, limit, … }]
```

USD limits are decimal strings; an amount a USD rule needs but no price
covers fails closed (`pricing.unavailable`). `comparePolicies` says which
fields of an amendment tighten (they apply at once) and which loosen (they
wait the active version's delay).

## Intent links

```ts
import { expandLink, validateLinkDefinition } from "@kletia/core";

const result = validateLinkDefinition(body);                   // the API's static rules, locally
const plan = expandLink(storedLink, { network: "arbitrum", asset: "USDC", amount: "250" });
plan.actions;              // [bridge arbitrum → base, deposit "max"] with pinned recipients and contracts
plan.requiredVms;          // ["evm"]: one visitor account per virtual machine
```

## Asset-change preview

`aggregatePreview` nets the simulated (or quoted) effect of every step of an
intent per network, account and asset, collapses money that only passes
through a wallet, prices it, and labels every number with its certainty
(`simulated`, `simulated-assumed-funds`, `venue-minimum`, `quoted`,
`estimated`). Its `digest` pins what moves; `materialChange` tells whether a
fresh preview is materially worse than the one the user acknowledged.

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
