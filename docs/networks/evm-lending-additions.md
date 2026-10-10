# SparkLend and Yearn V3

Kletia executes supply/deposit and withdrawal intents through two additional
protocols on Ethereum mainnet. Addresses resolve only from the core registry;
an arbitrary vault address cannot become an execution venue. The user's wallet
signs every transaction. These integrations do not register third-party contracts
in the public application.

| Protocol | Curated venue | Supported actions |
|---|---|---|
| SparkLend | USDC reserve | Supply, exact withdrawal, full-position withdrawal |
| SparkLend | WETH reserve | Supply, exact withdrawal, full-position withdrawal; native ETH wrap/unwrap |
| Yearn V3 | USDC-1 yVault | Deposit, exact withdrawal, full share redemption |

Examples:

```text
deposit 100 USDC into spark on ethereum
withdraw all USDC from spark on ethereum
deposit 104 USDC into yearn usdc-1 on ethereum
withdraw all USDC from yearn on ethereum
```

Structured intents use protocol `spark` or `yearn-v3`; the Yearn venue can be
selected as `params.venue: "usdc-1"`. The canonical venue IDs are
`ethereum:spark:usdc`, `ethereum:spark:weth` and
`ethereum:yearn-v3:usdc-1`.

## Identity and execution checks

SparkLend uses the Aave V3 pool ABI with independent Spark registry pins. Each
plan and preparation reads the reserve receipt from both the pool and data
provider, checks the underlying decimals and reserve status, and checks the
supply cap or withdrawal liquidity. A frozen reserve may still be withdrawn;
paused or inactive reserves fail closed. Prepare reads the current balance and
allowance, adds an exact approval when needed, and simulates executable calls.
Supply and withdrawal receipts require account-bound Pool events and matching
token movement; a successful receipt alone does not settle an intent.

Yearn verifies `asset()`, share decimals, the pinned API version and endorsement
by a pinned official Yearn registry before every plan and preparation. The
USDC-1 vault is endorsed by the **legacy** official V3 registry; current and legacy
registry reads are both required, and endorsement in either establishes
provenance. `maxDeposit` and `maxWithdraw` constrain the current amount. Registry
endorsement establishes deployment provenance; it does not guarantee vault
profitability or constitute a Kletia security audit.

Yearn's standard three-argument `redeem` allows a default loss of 100%. Kletia
always encodes the four-argument overload with `maxLoss = 1` basis point for a
full close, and the four-argument `withdraw` with `maxLoss = 0` for an exact exit.
Simulation and receipt verification also enforce the guaranteed minimum assets,
the loss-limit overload, the exact owner/receiver, the share burn and the token
payout. Deposits enforce the previewed share floor and the actual share mint.

## Source and read-only evidence

Canonical deployment sources:

- [Spark's address registry](https://github.com/sparkdotfi/spark-address-registry/blob/master/src/SparkLend.sol).
- [Yearn V3 contract addresses](https://docs.yearn.fi/developers/addresses/v3-contracts), including the current and legacy endorsement registries.
- [Yearn's official USDC-1 discovery record](https://ydaemon.yearn.fi/1/vaults/0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204).
- [Yearn's vault implementation](https://github.com/yearn/yearn-vaults-v3/blob/master/contracts/VaultV3.vy), documenting explicit withdrawal loss limits.

The [read-only evidence snapshot](evidence/evm-lending-additions.json) records
17 successful Ethereum contract calls at block **26160576**, the calldata,
decoded results and deployed runtime bytecode hashes. It confirms both Spark
receipt identities, active/unpaused/unfrozen reserve state, and Yearn's USDC
underlying, six share decimals, API version `3.0.2` and legacy-registry endorsement.
State values are observations at that block; adapters re-read them at runtime.
The bytecode hashes in the snapshot are evidence, not a new runtime upgrade pin.

Public endpoints were checked through the configured session proxy. Several
returned Cloudflare HTTP 403; Ankr required an API key, and Flashbots did not
whitelist `eth_call`. The successful reads used the public bloXroute endpoint.
No transaction was signed or broadcast, and no funded end-to-end result is
claimed by this snapshot.

## Regression coverage

`lendingSpark.test.ts` and `lendingYearn.test.ts` exercise real encoded calldata
and receipt verification against the in-process EVM transport. They cover stale
reserve identity, revoked allowance and endorsement, paused/frozen/capped state,
unknown venue addresses, output floors and wrong beneficiaries, bounded Yearn
exits, full-position withdrawals, metrics and recovery of a delayed receipt using
the same submitted reference. Existing Aave and Morpho regression tests run
alongside them to check the shared adapter behavior.

Run from `apps/api`:

```bash
node --import tsx --test src/platform/engine/__tests__/lendingSpark.test.ts src/platform/engine/__tests__/lendingYearn.test.ts src/platform/engine/__tests__/lendingAave.test.ts src/platform/engine/__tests__/lendingMorpho.test.ts
```
