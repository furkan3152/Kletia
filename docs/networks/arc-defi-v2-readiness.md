# Arc DeFi execution readiness

Historical Arc Swap, Staking and Lending deployments remain available for
reading balances, removing LP, unstaking and funded claims, withdrawing existing
lending positions, and repaying existing debt. New swaps, LP additions, stakes,
collateral/supply deposits and borrowing require the reviewed V2 contracts.
The repository contains V2 source and local regression evidence. It does not
contain a deployed V2 address or a funded public-network V2 execution claim.
With the default environment, those new-capital actions are paused before an
approval or transaction payload is created.

## Source identity and activation

Compile the Arc contracts and run:

```bash
npm run compile:arc
npm run check:arc-runtime-pins
```

`tooling/generate-arc-runtime-pins.mjs` obtains runtime bytecode and compiler
immutable-reference locations from Hardhat build information. It patches only
the canonical token and trusted-forwarder constructor addresses and rejects
unexpected immutable names or lengths. Its generated hashes live in
`apps/api/src/networks/arc/reviewedRuntimePins.ts`. Changing reviewed source,
compiler settings or constructor identities changes the hash and requires a
reviewed regeneration. The Arc contract test deploys the compiled source
locally and checks that actual deployed runtime matches these pins; alternate
forwarder or token identities fail the same comparison.

After completing `contracts/arc/DEFI_V2_MIGRATION.md`, configure each deployed
address together with its generated reviewed hash in the API:

```dotenv
ARC_SWAP_V2_ADDRESS=
ARC_SWAP_V2_RUNTIME_CODEHASH=
ARC_STAKING_V2_ADDRESS=
ARC_STAKING_V2_RUNTIME_CODEHASH=
ARC_LENDING_V2_ADDRESS=
ARC_LENDING_V2_RUNTIME_CODEHASH=
```

Both fields absent disables that protocol's new-capital routes. Partial values,
zero or historical contract addresses, and hashes different from compiled
reviewed source fail configuration. An operator-selected address and arbitrary
hash cannot authorize execution. Set the matching public addresses for the web
application only after API activation:

```dotenv
VITE_ARC_SWAP_V2_ADDRESS=
VITE_ARC_STAKING_V2_ADDRESS=
VITE_ARC_LENDING_V2_ADDRESS=
```

Every V2 action checks Arc chain ID `5042002` and exact live runtime bytecode
before preparing a plan. New lending exposure also checks the reviewed Swap V2
runtime and the Lending V2 stored `swapPool` address. Repayment and withdrawals
still check Lending V2's own runtime, while preserving its oracle-outage exit
behavior. The source contract rejects borrowing and withdrawals of indebted
collateral when its oracle is unavailable or stale; repayment, native USDC
withdrawal and debt-free collateral exits retain their independent paths.

Swap V2 calls carry the stricter of the explicit user output floor and the
slippage-derived floor, plus a five-minute expiry. Both swap directions enforce
these bounds in contract calldata. All transaction routes retain simulation and
the existing approval checks.

## Historical positions and explicit exits

After activation, the portfolio reports active contract addresses and separate
`legacyDefi` entries for historical LP, stake, pending unstake, rewards,
collateral, supply and debt balances at the same observed block. It does not
count the same position twice when the historical contract remains the active
read target. Oracle-dependent health/price values become `null` with
`unavailable` metadata when their read fails; the existing balances remain
visible.

Read-only Swap, Staking and Lending info/user endpoints accept
`?deployment=legacy` to select their pinned historical deployment. Omitted or
`active` selects the active read deployment; arbitrary addresses are rejected.
The historical target for an executable exit requires an explicit current-turn
marker such as:

```text
Repay 1 native USDC to Kletia Legacy Lending on Arc Testnet; prepare the route and simulate it before wallet approval
Remove 1 LP tokens from Kletia Legacy Swap on Arc Testnet; simulate it before wallet approval
Unstake 1 native USDC from Kletia Legacy Staking on Arc Testnet and start the contract-defined cooldown; simulate it before wallet approval
```

The Arc parser and entity resolver accept that marker only for the matching
exit family. A semantic model cannot invent a historical target, drop the
user's historical target, or use the marker to authorize new exposure.
The independent legacy Vault migration action keeps its original behavior.

## Regression coverage

API tests `arcDefiReadiness.test.ts`, `arcLegacyParsing.test.ts` and
`arcLegacyPositions.test.ts` cover disabled new capital before any RPC, reviewed
configuration and identity rejection, historical exit targets, bounded swap
calldata, deterministic and consented semantic target binding, balance
visibility after a deployment switch, and lending HTTP reads during oracle
outages. `contracts/arc/test/runtime-pins.test.js` checks actual local deployed
runtime and constructor identity drift. These checks do not imply a public
deployment, funded external execution, or a security audit.
