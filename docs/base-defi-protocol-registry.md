# Base DeFi Protocol Registry and Execution Boundary

## Purpose and scope

This document describes the Base Mainnet DeFi inventory represented by
`apps/api/src/networks/base/protocols.ts`, the distinction between
protocol discovery and transaction execution, and the owner actions required
for the existing Kletia Fee Router.

In this document, **source-verified** means that an address was matched to an
official protocol documentation page or an official protocol repository. It
does not mean that a fresh Base block, a current rate, current liquidity,
protocol solvency, or economic safety is asserted here. Those properties must
be checked at runtime.

The chain boundary is Base Mainnet, chain ID `8453`. Arc contracts, tokens,
quotes, and policies are out of scope and must never be admitted by this
registry.

No Solidity contract was added or changed for this registry expansion. No
contract was deployed, no owner transaction was sent, no allowance was
changed, and no user transaction was signed. The verification procedure is
read-only and does not require a private key.

## Inventory summary

| Registry surface                           | Count | Current execution meaning                                                                                                                         |
| ------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token symbols                              |    32 | 31 unique addresses because `ETH` intentionally resolves to Base WETH for calldata construction                                                   |
| Aave V3 reserves                           |    15 | Direct lending routes when the requested reserve and action pass live reads                                                                       |
| Moonwell markets                           |    21 | Direct lending routes; never wrapped through the Fee Router                                                                                       |
| Compound V3 Comets                         |     5 | Direct lending routes; never wrapped through the Fee Router                                                                                       |
| ERC-4626 vaults                            |    15 | 4 Moonwell, 3 Seamless, 2 Spark, and 6 Fluid direct routes                                                                                        |
| Staking targets                            |     3 | veAERO, stkWELL, and stkSEAM direct routes                                                                                                        |
| Morpho registry contracts                  |     3 | Discovery only; generic execution is disabled without exact `MarketParams`                                                                        |
| Configured existing swap execution targets |    10 | Current quote adapters may produce routes for these targets, subject to live quote, policy, allowlist, and simulation                             |
| Swap expansion candidates                  |    11 | 8 require an adapter and Fee Router allowlisting, 1 requires dynamic API binding, and 2 are incompatible with the current Permit2-less Fee Router |

The counts above describe configured coverage, not a promise that every
protocol supports every token or that every target is available at the time of
a request.

## Discovery is not execution

Kletia applies the following boundary:

1. An official source establishes the identity of a protocol address.
2. The local registry binds that address to Base, an asset, a protocol, a risk
   tier, and supported action classes.
3. Read-only runtime verification checks bytecode and protocol-specific
   bindings such as Aave reserve activity, Moonwell `underlying()`, Compound
   `baseToken()`, and ERC-4626 `asset()`.
4. A quote or market adapter obtains current onchain data for the exact user
   request. A registry row alone cannot manufacture a route.
5. The intent engine binds the requested chain, asset, amount, recipient,
   protocol restriction, deadline, and slippage.
6. Security checks and the strongest available transaction simulation run
   before ranking.
7. Direct lending, vault, and staking routes target the protocol itself. Swap
   routes that charge the Kletia fee must additionally pass the onchain Fee
   Router allowlist and a second wrapped simulation.
8. The user reviews and signs the resulting transaction.

The swap expansion registry currently contains no entry marked `live`. It is
an audited discovery backlog. `fee_router_allowlist_required`,
`dynamic_api_binding_required`, and `incompatible_permit2` entries are not
selected by the current swap engine.

Morpho follows the same fail-closed rule. Its Base core addresses are known,
but `executionReady` remains `false` because a safe Morpho call requires an
exact market tuple rather than the core address alone.

## Real quote, rate, and liquidity behavior

### Swaps

The current swap engine queries three independent source families in parallel:

- Aerodrome V1 stable and volatile curves plus Slipstream tick spacings;
- six V2-style routers with direct and supported hub paths;
- Uniswap V3 and PancakeSwap V3 direct and supported multi-hop fee paths.

A provider failure is recorded as unavailable instead of being converted into
a fake quote. A route is eligible only when an actual quote returns a positive
output and its transaction passes simulation or is explicitly classified as
deferred until the required token approval exists.

Ranking is deterministic:

1. a fully passed simulation ranks before approval-deferred simulation;
2. higher quoted token output ranks next;
3. lower quoter gas is only a tie-breaker when comparable;
4. stable text keys break any remaining tie.

Gas is not converted into the output token, execution latency is not
normalized, and quoted output is not a profitability estimate.

### Lending and vaults

For the requested asset, the lending adapter reads only matching Aave,
Moonwell, Compound, and ERC-4626 records. It filters inactive, paused,
unsupported, position-ineligible, cap-constrained, and liquidity-ineligible
routes.

Supply comparisons rank higher observed supply rates first. Borrow comparisons
rank lower observed variable borrow rates first. Risk tolerance filters the
candidate set before rate ranking. Rates and available liquidity are
best-effort point-in-time reads; they can change before execution. Gas,
incentives, future yield, and guaranteed borrowing cost are not projected.

All lending, vault, and staking execution remains `direct`,
`feeRouterCompatible: false`. This preserves caller and position ownership
semantics.

### Liquidity discovery

Liquidity discovery does not treat a router address as proof that a usable
pool exists. It:

- pins a Base block;
- resolves the pool through the registered factory;
- verifies the pool's two tokens;
- reads reserves and LP total supply at the pinned block;
- rejects zero-address, empty, and token-mismatched pools.

This establishes factory binding and reserve presence only. It does not infer
fee APR, future yield, depth at another block, price impact for an arbitrary
trade, or impermanent-loss outcomes.

## Lending, vault, and staking registry

### Aave V3 Base

| Role                   | Address                                      |
| ---------------------- | -------------------------------------------- |
| Pool                   | `0xa238dd80c259a72e81d7e4664a9801593f98d1c5` |
| Protocol Data Provider | `0x0f43731eb8d45a581f4a36dd74f5f358bc90c73a` |

Configured reserves: `WETH`, `cbETH`, `USDbC`, `wstETH`, `USDC`, `weETH`,
`cbBTC`, `ezETH`, `GHO`, `wrsETH`, `LBTC`, `EURC`, `AAVE`, `tBTC`, and
`syrupUSDC`.

All 15 reserve assets and both core addresses were matched to the official
[Aave V3 Base address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Base.sol).
The canonical repository is `aave-dao/aave-address-book`; the older
`bgd-labs/aave-address-book` URL redirects and should not be used as the
canonical citation.

### Moonwell Base

| Asset   | Market                                       |
| ------- | -------------------------------------------- |
| USDbC   | `0x703843c3379b52f9ff486c9f5892218d2a065cc8` |
| WETH    | `0x628ff693426583d9a7fb391e54366292f509d457` |
| cbETH   | `0x3bf93770f2d4a794c3d9ebefbaebae2a8f09a5e5` |
| DAI     | `0x73b06d8d18de422e269645eace15400de7462417` |
| USDC    | `0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22` |
| wstETH  | `0x627fe393bc6edda28e99ae648fd6ff362514304b` |
| rETH    | `0xcb1dacd30638ae38f2b94ea64f066045b7d45f44` |
| AERO    | `0x73902f619ceb9b31fd8efecf435cbdf89e369ba6` |
| weETH   | `0xb8051464c8c92209c92f3a4cd9c73746c4c3cfb3` |
| cbBTC   | `0xf877acafa28c19b96727966690b2f44d35ad5976` |
| EURC    | `0xb682c840b5f4fc58b20769e691a6fa1305a501a2` |
| wrsETH  | `0xfc41b49d064ac646015b459c522820db9472f4b5` |
| WELL    | `0xdc7810b47eaab250de623f0ee07764afa5f71ed1` |
| USDS    | `0xb6419c6c2e60c4025d6d06ee4f913ce89425a357` |
| tBTC    | `0x9a858ebff1beb0d3495bb0e2897c1528ed84a218` |
| LBTC    | `0x10ff57877b79e9bd949b3815220ec87b9fc5d2ee` |
| VIRTUAL | `0xde8df9d942d78ede3ca06e60712582f79cfffc64` |
| MORPHO  | `0x6308204872bdb7432df97b04b42443c714904f3e` |
| cbXRP   | `0xb4fb8fed5b3aaa8434f0b19b1b623d977e07e86d` |
| MAMO    | `0x2f90bb22eb3979f5ffad31ea6c3f0792ca66da32` |
| VVV     | `0xd64bcb70c613a6d1f4d7d57ba64bb4a0767a9682` |

The comptroller is
`0xfbb21d0380bee3312b33c4353c8936a0f13ef26c`; Moonwell Views is
`0x6834770aba6c2028f448e3259ddee4bcb879d459`. All 21 markets, both
support contracts, four Moonwell vaults, and stkWELL were matched to
[Moonwell's official Base contract list](https://docs.moonwell.fi/moonwell/protocol-information/contracts).

### Compound V3 Base

| Base asset | Comet                                        |
| ---------- | -------------------------------------------- |
| AERO       | `0x784efeb622244d2348d4f2522f8860b96fbece89` |
| USDbC      | `0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf` |
| USDC       | `0xb125e6687d4313864e53df431d5425969c15eb2f` |
| USDS       | `0x2c776041ccfe903071af44aa147368a9c8eea518` |
| WETH       | `0x46e6b214b524310239732d51387075e0e70970bf` |

Each Comet was matched to its `roots.json` under the official
[Compound Comet Base deployments](https://github.com/compound-finance/comet/tree/main/deployments/base).

### ERC-4626 vaults

| Protocol | Vault               | Asset  | Address                                      | Official source                                                                                          |
| -------- | ------------------- | ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Moonwell | Flagship USDC       | USDC   | `0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca` | [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts)                   |
| Moonwell | Flagship ETH        | WETH   | `0xa0e430870c4604ccfc7b38ca7845b1ff653d0ff1` | [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts)                   |
| Moonwell | Flagship EURC       | EURC   | `0xf24608e0ccb972b0b0f4a6446a0bbf58c701a026` | [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts)                   |
| Moonwell | Frontier cbBTC      | cbBTC  | `0x543257ef2161176d7c8cd90ba65c2d4caef5a796` | [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts)                   |
| Seamless | USDC Vault          | USDC   | `0x616a4e1db48e22028f6bbf20444cd3b8e3273738` | [Seamless contracts](https://docs.seamlessprotocol.com/technical/smart-contracts-1)                      |
| Seamless | cbBTC Vault         | cbBTC  | `0x5a47c803488fe2bb0a0eaaf346b420e4df22f3c7` | [Seamless contracts](https://docs.seamlessprotocol.com/technical/smart-contracts-1)                      |
| Seamless | WETH Vault          | WETH   | `0x27d8c7273fd3fcc6956a0b370ce5fd4a7fc65c18` | [Seamless contracts](https://docs.seamlessprotocol.com/technical/smart-contracts-1)                      |
| Spark    | sUSDC               | USDC   | `0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858` | [Spark Base registry](https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Base.sol)     |
| Spark    | Curated Morpho USDC | USDC   | `0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a` | [Spark Base registry](https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Base.sol)     |
| Fluid    | fUSDC               | USDC   | `0xf42f5795d9ac7e9d757db633d693cd548cfd9169` | [Fluid Base deployments](https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base) |
| Fluid    | fWETH               | WETH   | `0x9272d6153133175175bc276512b2336be3931ce9` | [Fluid Base deployments](https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base) |
| Fluid    | fEURC               | EURC   | `0x1943fa26360f038230442525cf1b9125b5dcb401` | [Fluid Base deployments](https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base) |
| Fluid    | fGHO                | GHO    | `0x8ddbffa3cfda2355a23d6b11105ac624bdbe3631` | [Fluid Base deployments](https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base) |
| Fluid    | fsUSDS              | sUSDS  | `0xf62e339f21d8018940f188f6987bcdf02a849619` | [Fluid Base deployments](https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base) |
| Fluid    | fwstETH             | wstETH | `0x896e39f0e9af61eca9dd2938e14543506ef2c2b5` | [Fluid Base deployments](https://github.com/Instadapp/fluid-contracts-public/tree/main/deployments/base) |

Runtime verification must still call `asset()` and compare it with the
registered underlying token before treating a vault as bound.

### Staking

| Position                      | Address                                      | Official source                                                                        |
| ----------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Aerodrome veAERO VotingEscrow | `0xebf418fe2512e7e6bd9b87a8f0f294acdc67e6b4` | [Aerodrome contracts](https://github.com/aerodrome-finance/contracts)                  |
| Moonwell stkWELL              | `0xe66e3a37c3274ac24fe8590f7d84a2427194dc17` | [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts) |
| Seamless stkSEAM              | `0x73f0849756f6a79c1d536b7abab1e6955f7172a4` | [Seamless contracts](https://docs.seamlessprotocol.com/technical/smart-contracts-1)    |

These contracts are direct execution targets because ownership and accounting
can depend on the downstream `msg.sender`.

### Morpho Blue discovery-only contracts

| Role                        | Address                                      |
| --------------------------- | -------------------------------------------- |
| Morpho core                 | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |
| Adaptive Curve IRM          | `0x46415998764c29ab2a25cbea6254146d50d22687` |
| Chainlink Oracle V2 factory | `0x2dc205f24bcb6b311e5cdf0745b0741648aebd3d` |

Source: [Morpho official contract addresses](https://docs.morpho.org/developers/contracts/addresses/).

These addresses support discovery only. The core address must not be converted
into a generic executable route without a separately verified loan token,
collateral token, oracle, IRM, and LLTV tuple.

## Swap surfaces

### Existing configured execution targets

The current verifier checks ten existing swap targets:

| Surface                  | Target                                       |
| ------------------------ | -------------------------------------------- |
| Aerodrome V1             | `0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43` |
| Aerodrome Slipstream     | `0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5` |
| Uniswap V2               | `0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24` |
| Uniswap V3 SwapRouter02  | `0x2626664c2603336e57b271c5c0b26f421741e481` |
| Alien Base               | `0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7` |
| PancakeSwap V2           | `0x8cfe327cec66d1c090dd72bd0ff11d690c33a2eb` |
| PancakeSwap Smart Router | `0x678aa4bf4e210cf2166753e054d5b7c31cc7fa86` |
| SushiSwap V2 Router02    | `0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891` |
| BaseSwap                 | `0x327df1e6de05895d2ab08513aadd9313fe505d86` |
| SwapBased                | `0xaaa3b1f1bd7bcc97fd1917c18ade665c5d31f066` |

Configured does not mean a route exists for a requested pair. The adapters
must obtain a live positive quote, bind an explicit user recipient, and pass
simulation.

### Expansion inventory

| Candidate                                 | Target                                       | Registry status                 | Official source                                                                                                                   |
| ----------------------------------------- | -------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0x AllowanceHolder                        | `0x0000000000001ff3684f28c67538d4d072c22734` | `dynamic_api_binding_required`  | [0x contracts](https://docs.0x.org/docs/core-concepts/contracts)                                                                  |
| 1inch AggregationRouterV6                 | `0x111111125421ca6dc452d289314280a0f8842a65` | `fee_router_allowlist_required` | [1inch Base quick start](https://business.1inch.com/portal/documentation/apis/swap/classic-swap/quick-start)                      |
| Odos Router V2                            | `0x19ceead7105607cd444f5ad10dd51356436095a1` | `fee_router_allowlist_required` | [Odos Router V2](https://github.com/odos-xyz/odos-router-v2)                                                                      |
| Kyber MetaAggregationRouterV2             | `0x6131b5fae19ea4f9d964eac0408e4408b66337b5` | `fee_router_allowlist_required` | [Kyber contracts](https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/contracts)                                  |
| Balancer V2 Vault                         | `0xba12222222228d8ba445958a75a0704d566bf2c8` | `fee_router_allowlist_required` | [Balancer Base deployment](https://github.com/balancer/balancer-deployments/blob/master/v2/tasks/20210418-vault/output/base.json) |
| Curve Router                              | `0x4f37a9d177470499a2dd084621020b023fcffc1f` | `fee_router_allowlist_required` | [Curve Base constants](https://github.com/curvefi/curve-js/blob/master/src/constants/network_constants.ts)                        |
| WOOFi V2 Router                           | `0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7` | `fee_router_allowlist_required` | [WOOFi Base contracts](https://learn.woo.org/woofi-docs/woofi-dev-docs/references/readme/base)                                    |
| Maverick V1 Router                        | `0x32aed3bce901da12ca8489788f3a99fce1056e14` | `fee_router_allowlist_required` | [Maverick V1 contracts](https://docs.mav.xyz/technical-reference/contract-addresses/v1-contract-addresses)                        |
| Aerodrome Slipstream Gauges V3 SwapRouter | `0x698cb2b6dd822994581fea6ea4fc755d1363a92f` | `fee_router_allowlist_required` | [Aerodrome Slipstream](https://github.com/aerodrome-finance/slipstream)                                                           |
| Uniswap Universal Router v2.1.1           | `0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7` | `incompatible_permit2`          | [Uniswap deployments](https://developers.uniswap.org/deployments.json)                                                            |
| Pancake Infinity Universal Router         | `0xd9c500dff816a1da21a48a732d3498bf09dc9aeb` | `incompatible_permit2`          | [Pancake Base deployment](https://github.com/pancakeswap/infinity-universal-router/blob/main/deploy-addresses/base-mainnet.json)  |

Official address identity is only the first gate. None of these eleven entries
has a current executable adapter merely because it appears in this table.

## Dynamic API and Permit2 boundaries

### 0x

0x distinguishes the allowance spender from the transaction entry point.
Kletia must bind, from the same validated API response:

- `issues.allowance.spender`;
- `transaction.to`;
- chain ID, sell token, buy token, exact sell amount, calldata, value, minimum
  output, recipient, and expiry.

Settler addresses can be dynamic and must not be guessed or globally
allowlisted. The static AllowanceHolder address is not enough to make an
arbitrary 0x response executable. The 0x candidate therefore must remain
`dynamic_api_binding_required` until a dedicated response validator and
adapter exist.

The same general response-binding rule applies to calldata obtained from
1inch, Odos, Kyber, or another aggregation API: the API response cannot
override the expected Base chain, target family, spender, recipient, asset,
amount, slippage, or deadline.

### Uniswap and Pancake universal routers

[Uniswap Universal Router](https://developers.uniswap.org/docs/protocols/universal-router/overview)
integrates Permit2. Pancake Infinity's official
[command definitions](https://github.com/pancakeswap/infinity-universal-router/blob/main/src/libraries/Commands.sol)
include Permit2 transfer and permit commands.

The current `KletiaSmartRouter.executeERC20` flow transfers the input token to
Kletia, approves only `targetProtocol`, then calls that target. It does not
construct or sign a user Permit2 authorization. Therefore the two universal
router targets must remain `incompatible_permit2` and must not be added to the
current Fee Router allowlist.

This is an incompatibility with the current execution model, not a claim that
those protocols can never be integrated. A future Permit2-aware adapter or a
new, separately reviewed router design would require its own tests, simulation
policy, and deployment decision.

## Kletia Fee Router boundary

The existing Base Kletia Fee Router is:

`0x8214b00f49da60684ce4b2c0b16ddb8a29d777cf`

Its owner-controlled capability is:

```solidity
setApprovedTarget(address target, bool isApproved)
```

`executeERC20` pulls one input token into Kletia, deducts the fee, approves the
downstream target, and performs a normal `call`. The downstream protocol sees
the Kletia router as `msg.sender`. The contract refunds remaining input-token
balance but does not generically sweep an unrelated output token to the user.
Consequently, executable swap calldata must encode and validate the user as
the explicit output recipient.

The backend further rejects fee-wrapped routes with multiple declared inputs
or multiple approvals, reads `approvedTargets` onchain, and simulates the
wrapped transaction before ranking it.

Lending, ERC-4626, and staking addresses must not be allowlisted merely because
they are source-verified. The current adapters deliberately execute them
directly to preserve ownership semantics. Some individual functions, such as
Aave `supply(..., onBehalfOf, ...)` or ERC-4626
`deposit(assets, receiver)`, could support an explicit beneficiary in a
purpose-built design, but that does not make the complete protocol safely
compatible with this generic Fee Router.

## Exact owner action plan

These are transaction intentions for the router owner to review after a fresh
read-only verification. They were **not executed** while producing this
document.

### Immediate stale-target cleanup

If `approvedTargets(target)` still returns `true`, the owner should prepare
exactly these revocations:

```text
setApprovedTarget(0x628ff693d22751d3691740560fcfec11e03a3a95, false)
setApprovedTarget(0xcc970d2bb6cb7d9e0eebb17c7674251214a3d0ae, false)
setApprovedTarget(0x71524b4f93c58fcbf659783284e38825f0622859, false)
```

These are stale Moonwell WETH and cbBTC alternatives and are not the current
official markets. The current source-verified markets are:

- WETH: `0x628ff693426583d9a7fb391e54366292f509d457`
- cbBTC: `0xf877acafa28c19b96727966690b2f44d35ad5976`

The corrected Moonwell markets remain direct lending targets; they should not
be added to the Fee Router allowlist.

`0x71524b4f93c58fcbf659783284e38825f0622859` is the Sushi V2 factory,
not Router02. The executable Base Router02 is
`0x6bded42c6da8fbf0d2ba55b2fa120c5e0c8d7891`. Do not add that router to
the legacy address-only Fee Router merely to restore coverage; enable it only
through the versioned typed V2 adapter after calldata-binding and fork tests.

### Deferred allowlist additions

Do not send any of the following additions yet. Each is allowed only after a
protocol-specific calldata adapter exists, response and selector binding tests
pass, the recipient is explicitly bound to the user, runtime code and
protocol identity are rechecked, and the fee-wrapped transaction passes
simulation:

```text
setApprovedTarget(0x111111125421ca6dc452d289314280a0f8842a65, true)  # 1inch
setApprovedTarget(0x19ceead7105607cd444f5ad10dd51356436095a1, true)  # Odos
setApprovedTarget(0x6131b5fae19ea4f9d964eac0408e4408b66337b5, true)  # Kyber
setApprovedTarget(0xba12222222228d8ba445958a75a0704d566bf2c8, true)  # Balancer V2
setApprovedTarget(0x4f37a9d177470499a2dd084621020b023fcffc1f, true)  # Curve
setApprovedTarget(0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7, true)  # WOOFi
setApprovedTarget(0x32aed3bce901da12ca8489788f3a99fce1056e14, true)  # Maverick V1
setApprovedTarget(0x698cb2b6dd822994581fea6ea4fc755d1363a92f, true)  # Aerodrome Slipstream Gauges V3
```

Approval is per target, not an all-at-once migration. A target should move to
`live` only after its own adapter and verification gates pass.

### Explicitly held targets

Do not approve these targets under the current design:

```text
0x0000000000001ff3684f28c67538d4d072c22734  # 0x: dynamic API binding required
0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7  # Uniswap Universal Router: Permit2
0xd9c500dff816a1da21a48a732d3498bf09dc9aeb  # Pancake Infinity: Permit2
```

Do not add Aave, Moonwell, Compound, ERC-4626 vault, Morpho, or staking targets
to the Fee Router as a shortcut around their direct-execution policy.

## Live verification snapshot

The following values came from a successful read-only verification on
2026-07-29. They are retained as evidence of that run, not as current promises:

| Field                                       | Observed value                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Verification status                         | `verified`; no registry failure                                                        |
| Base block                                  | `49271032`                                                                             |
| Observed at                                 | `2026-07-29T13:23:31.845Z`                                                             |
| Runtime-code targets checked                | 56                                                                                     |
| Historical configured swap targets approved | 8 of 10; this snapshot still counted the misconfigured Sushi factory as a router       |
| Correct Sushi Router02 approved             | `false`; intentionally held for the typed V2 adapter                                   |
| BaseSwap / SwapBased approved               | `false` / `false`                                                                      |
| Unsafe or stale targets still approved      | 2 stale Moonwell markets plus the Sushi factory; all three revocations remain required |
| Expansion candidates approved               | 0 of 11                                                                                |

Point-in-time USDC rates at block `49271032`:

| Action | Protocol ordering | Observed rate |
| ------ | ----------------- | ------------: |
| Supply | Compound V3       |       463 bps |
| Supply | Moonwell          |       420 bps |
| Supply | Aave V3           |       354 bps |
| Borrow | Aave V3           |       443 bps |
| Borrow | Moonwell          |       529 bps |
| Borrow | Compound V3       |       557 bps |

Vaults whose adapters did not expose a directly comparable live rate remained
`null`; the verifier did not turn that absence into zero or an invented APY.

The liquidity discovery snapshot was pinned to block `49271030` and found four
factory-bound, reserve-bearing USDC/AERO pools:

| Protocol   | Pool                                         | USDC reserve, atomic | AERO reserve, atomic |
| ---------- | -------------------------------------------- | -------------------: | -------------------: |
| Uniswap V2 | `0x9ded8b880fa4128ba9c564823e403c1ea5e04b8d` |               116859 |   273669683116975031 |
| Alien Base | `0x70d36b7baf00870b7eda214d4abbfdd4fd84bff0` |             13311256 | 31732340328752938150 |
| BaseSwap   | `0x3019f959c1fa8f4854e5ed8a477a38267f6bcef5` |               856839 |  2031360122746108470 |
| SwapBased  | `0x5bc67949ee64273ec0b7cee56dfc8f48091d0c9a` |                22675 |    54887632613262065 |

Three configured discovery sources were unavailable during that snapshot.
Their failures were not replaced with synthetic pools. The reserves above use
the tokens' raw onchain precision and do not imply fee APR, future yield,
trade-size price impact, or impermanent-loss outcomes.

## Verification commands

Use Node `20.19.0` or newer and a private Base Mainnet RPC where possible. From
the repository root:

```bash
cd apps/api
node --version
npm run typecheck
node node_modules/vitest/vitest.mjs run \
  src/tests/base-protocol-registry.test.ts \
  src/tests/fee-router-compatibility.test.ts \
  src/tests/efficiency-engine.test.ts \
  src/tests/dex-quote-availability.test.ts \
  src/tests/lending-market-status.test.ts
BASE_RPC_URL="https://replace-with-a-private-base-mainnet-rpc" \
  npm run verify:base-registry
```

`verify:base-registry` is read-only. It checks:

- Base runtime bytecode for registered execution targets;
- V2-style swap targets expose a live factory and canonical Base WETH;
- Aerodrome Router `defaultFactory()` matches the configured factory and its
  FactoryRegistry currently approves that factory;
- all 15 Aave reserve active flags;
- all 21 Moonwell market-underlying bindings;
- all 5 Compound Comet base-token bindings;
- all 15 ERC-4626 asset bindings;
- current, stale, and expansion Fee Router allowlist values;
- point-in-time USDC supply and borrow comparisons;
- factory-bound USDC/AERO pools and their reserve-bearing runtime contracts.

It emits the current block and observation time. Do not quote its rates,
reserves, or allowlist results later without retaining that context.

Optional direct read-only owner and allowlist checks:

```bash
cast call 0x8214b00f49da60684ce4b2c0b16ddb8a29d777cf \
  "owner()(address)" \
  --rpc-url "$BASE_RPC_URL"

cast call 0x8214b00f49da60684ce4b2c0b16ddb8a29d777cf \
  "approvedTargets(address)(bool)" \
  0x628ff693d22751d3691740560fcfec11e03a3a95 \
  --rpc-url "$BASE_RPC_URL"

cast call 0x8214b00f49da60684ce4b2c0b16ddb8a29d777cf \
  "approvedTargets(address)(bool)" \
  0xcc970d2bb6cb7d9e0eebb17c7674251214a3d0ae \
  --rpc-url "$BASE_RPC_URL"
```

These `cast call` commands do not change chain state. No `cast send`, deploy
command, wallet key, or owner signature is part of this runbook.
