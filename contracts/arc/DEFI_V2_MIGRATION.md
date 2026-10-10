# Arc DeFi V2 release and migration

The source-ready V2 contracts are separate, non-upgradeable contracts. They have
not been deployed by this change. The canonical `deployments/arc-testnet.json`
continues to describe the existing contracts and must not be used as evidence
for these new identities.

## Corrected execution boundaries

- `KletiaArcSwapV2` requires a positive minimum output and a deadline on both
  swap directions. A reserve move that produces less than the signed minimum
  reverts atomically. Token collection and delivery require exact balance
  deltas; taxed token transfers are rejected.
- `KletiaArcStakingV2` integrates APR over time in a global reward index and
  checkpoints each user before stake changes and claims. An APR change applies
  prospectively and preserves rewards earned during previous periods. Reward
  payments still require an explicitly funded reward pool; future reward
  funding is not guaranteed by compilation or the unit suite.
- `KletiaArcLendingV2` rejects unavailable, future, stale or decreasing oracle
  observations before issuing new debt, removing collateral from an indebted
  position, or liquidating a position. `MAX_ORACLE_AGE` is 900 seconds. Debt
  repayments, liquidity withdrawals with sufficient pool balance, and
  debt-free collateral exits remain possible during an oracle outage. A
  deployment takes its first cumulative-price baseline in the constructor;
  a positive subsequent TWAP is required before borrowing. `refreshOracle()`
  can update the observation without moving assets.

The local tests retain explicit legacy characterization cases: the old swap
does not enforce user output/expiry bounds, the old staking contract reprices
uncheckpointed historical rewards when APR changes, and the old lending
contract can borrow against retained TWAP after an oracle outage. Passing those
tests documents the old behavior; it does not resolve the old deployments.

## Constructor arguments and application ABI

| Source | Constructor arguments | Changed application calls |
| --- | --- | --- |
| `contracts/KletiaArcSwapV2.sol` | `(trustedForwarder, token)` | `swapUSDCForToken(uint256 minAmountOut, uint256 deadline)` payable; `swapTokenForUSDC(uint256 tokenAmount, uint256 minAmountOut, uint256 deadline)` |
| `contracts/KletiaArcStakingV2.sol` | `(trustedForwarder, aprBps, cooldownPeriod)` | Existing public operation signatures are preserved. The deployer is the initial owner. |
| `contracts/KletiaArcLendingV2.sol` | `(trustedForwarder, kletToken, swapPool)` | Existing public operation signatures are preserved; `refreshOracle()` and `MAX_ORACLE_AGE()` are added. |

The token and forwarder must be the reviewed Arc identities. The lending
`swapPool` must be the reviewed cumulative-price source for the actual collateral
pair. A successful RPC read or matching runtime hash is not proof of sufficient
oracle liquidity, manipulation resistance, economic solvency or an audit.

## Before enabling new capital

1. Run `npm test` in this workspace on the repository's supported Node version.
   Add pinned-fork tests against the intended token, forwarder and price source.
2. Review initial ownership, APR, cooldown, oracle liquidity and failure policy.
   Compile with the workspace's pinned Solidity/Cancun profile.
3. Deploy each reviewed V2 contract, record confirmed receipts and constructor
   arguments, and verify exact source independently. Do not relabel the legacy
   deployments or their evidence as V2.
4. Publish the confirmed addresses and observed runtime code hashes in a new
   deployment evidence record. Configure the application's explicit V2 address
   and identity pins only after that record exists. Missing or mismatched V2
   identities must keep new-capital execution disabled.
5. Re-read actual deployed token, forwarder, owner and oracle bindings at a pinned
   block, exercise successful and failed calls by simulation, and run the live
   readiness gate before accepting users' new capital.

This source change performs none of the deployment or funded steps above.

## Existing positions

Positions stay attached to their original contract address until confirmed
withdrawal and deposit transactions establish a migration. Legacy swap liquidity
can be removed through the user's original LP balance. Legacy staking principal
requires its unstake/cooldown/claim sequence. Legacy lending debt must be repaid
on the old contract before its collateral can be moved; supplier withdrawals
remain subject to the old contract's pool liquidity. A V2 balance cannot stand
in for an old position, and a receipt from one contract cannot close a position
in another.

Keep legacy principal exits explicit and separate from V2 actions. New swap,
stake, liquidity supply and borrow actions must use only validated V2 addresses.
Funding or moving user positions requires its own authorized transactions.
