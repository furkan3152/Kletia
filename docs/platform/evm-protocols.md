# EVM protocols

The venues added in October 2026 on the five production EVM networks (Base,
Arbitrum One, Ethereum, OP Mainnet and Polygon PoS). Every address was read
back on-chain on 2026-10-23 with read-only calls (`eth_call`, `eth_getStorageAt`); the
results are in
[`packages/core/test/fixtures/protocols-2026-10-23-evm.json`](../../packages/core/test/fixtures/protocols-2026-10-23-evm.json)
and `packages/core/test/round9.test.mjs` fails if any pin is missing from it.
Adapters read addresses only from the registry (`YIELD_VENUES`,
`VENUE_CONTRACTS`, `CURVE_POOLS`); they never take one from a provider.

## What was added

| Protocol | Network | Kind | Venue | Source of the address |
|---|---|---|---|---|
| Curve | Arbitrum One | swap | stable-ng USDC / USDT0 pool `0x49b7…2A8F` | Curve API pool list; the stable-ng factory `get_coins` and `find_pool_for_coins` confirm it |
| Compound V3 | Ethereum | lend | cUSDTv3 `0x3Afd…0840`, cUSDSv3 `0x5D40…7b56` | Compound docs deployment tables; `baseToken()` read back |
| Compound V3 | Base | lend | cAEROv3 `0x784e…cE89` | Compound docs; `baseToken()` read back |
| Morpho Vaults | Ethereum | lend | Spark Blue Chip USDT, Steakhouse Prime USDT, sky.money USDS Flagship (Vault V2), Gauntlet WETH Prime (v1.0) | Morpho API listing; factory `isVaultV2` / `isMetaMorpho`, `asset()`, gates read back |
| Morpho Vaults | Base | lend | Steakhouse High Yield USDC Edition, Grove x Steakhouse USDC (Vault V2), Steakhouse EURC (v1.0) | as above |
| Morpho Vaults | Arbitrum One | lend | Bitget x Steakhouse USDT0 (Vault V2) | as above |
| Morpho Vaults | OP Mainnet | lend | Re7 WETH (Vault V2; the OP VaultV2Factory is now pinned) | as above |
| Morpho Vaults | Polygon PoS | lend | Compound WETH (v1.1) | as above |
| Sky Savings (`sky`) | Ethereum | lend | sUSDS (USDS, UUPS proxy, implementation pinned), sDAI (DAI, immutable; `pot()` and `daiJoin()` pinned) | Sky / Spark deployments; slot and views read back |
| Ethena (`ethena`) | Ethereum | lend (deposit only) | sUSDe (USDe, immutable; `silo()` pinned) | Ethena deployment; `asset()`, `silo()`, `cooldownDuration()` read back |
| Kelp (`kelp`) | Ethereum | stake | LRTDepositPool, LRTConfig, LRTOracle, rsETH | `lrtConfig()`, `rsETH()`, `getContract(LRT_DEPOSIT_POOL / LRT_ORACLE)` read back |
| Renzo (`renzo`) | Ethereum | stake | RestakeManager, RenzoOracle, ezETH | `ezETH()`, `renzoOracle()` read back |

New assets on Ethereum: USDe, rsETH and ezETH. New price sources: Chainlink
USDe / USD and ezETH / ETH (times ETH / USD). rsETH has no confirmed feed, so
it is unpriced (no swap guard or USD rule can use it; staking into it still
works and its USD value reads as unknown).

## How each one is checked

- **Curve (Arbitrum).** Same adapter as the Ethereum 3pool: `coins(i)` is
  re-read before every quote, `get_dy` is held to the Chainlink band, and
  `exchange(i, j, dx, min_dy)` carries the on-chain floor. USDT on Arbitrum
  resolves to USDT0, so "swap 100 USDC to USDT via curve on arbitrum" plans.
- **Sky Savings and Ethena** run on the shared ERC-4626 engine as a new venue
  kind, `savings-vault`. Before every plan, prepare and fact read the
  EIP-1967 implementation slot must equal the pin (sUSDS) or be empty (sDAI,
  sUSDe), and every pinned view must return its address. Deposits are capped
  by `maxDeposit`. sDAI exits are minted to the account by the DaiJoin; the
  proof accepts that mint.
- **Ethena exits.** While `cooldownDuration()` is set, sUSDe's withdraw and
  redeem revert: the holder calls `cooldownShares`, waits, then `unstake`.
  The registry lists sUSDe for deposits only, every deposit carries a warning
  with the cooldown read at planning time, the adapter never encodes an exit,
  and positions report nothing withdrawable now.
- **Kelp** encodes `depositETH(minRSETHAmountExpected, "")` with the
  guaranteed rsETH as the minimum, so the step's floor is on-chain.
- **Renzo** `depositETH()` takes no minimum: the expected ezETH is Renzo's own
  `calculateMintAmount(totalTVL, amount, supply)`, the guarantee is held by the
  proof (`floor: "claimed"`) and prepare dry-runs the exact call.
- **Restaking exits.** Kelp and Renzo withdrawals go through their own
  queues and are not supported. Every stake warns about slashing risk and
  names the way out (a swap back for ezETH; Kelp's own redemption for rsETH,
  which Kletia cannot price).

## Not added, and why

| Requested | Decision |
|---|---|
| Uniswap V4 | Skipped: Universal Router command encoding (V4_SWAP actions, settle / take) is not verified here. |
| Curve on OP Mainnet, Polygon PoS, Base | No Curve pool between registry assets holds real liquidity there (Curve API, 2026-10-23); none pinned. |
| Balancer V2 / V3 | Skipped: V2 composable stable pools were exploited in November 2025 and many are paused or in recovery mode; no pool was verifiable as safe to route. |
| SushiSwap V3 | Skipped: Sushi's own configuration lists the V3 factory and quoter but no V3 swap router; Sushi swaps run through its RouteProcessor, whose route encoding is not verified here. |
| Compound V3 on Polygon USDC | The Polygon USDC comet's base token is bridged USDC.e, which is not a registry asset. |
| Euler v2, Beefy | Skipped: no provenance check (factory proof) was built for their vaults. |
| Coinbase cbETH staking | Not permissionless: only Coinbase mints cbETH. Buying cbETH at market already works (a swap). |
| Swell swETH | Skipped: the only on-chain swETH rate feed found is a RedStone feed, and Swell's deposit has no minimum. |
| Stargate V2 | Skipped: quoting and taxi calldata were not verified. |

## Sentence reader

The grammar reads the new staking words ("stake 1 ETH with kelp", "with
renzo", "rseth", "ezeth") from the registry. Lending words are hand-written in
the reader, so "into sky", "into susds", "into sdai" and "into ethena" are not
read yet; the venues are reachable through structured actions
(`{"kind":"deposit","from":"USDS","protocol":"sky"}`) and the API.
