# Kletia contracts for Arc Testnet (@kletia/contracts-arc)

The Arc-specific Solidity workspace for contracts deployed on Arc Testnet (`5042002`). This includes the Kletia application token (KLET), solvency-guaranteed savings (KletiaArcVaultV2), and Arc-native DeFi primitives (Swap, Lending, Staking). The network leverages `KletiaArcForwarder` as a shared ERC-2771 trust root for gasless operations.

## Layout

- `KletiaArcVaultV2`: the vault that takes new deposits; it enforces aggregate principal and interest liabilities.
- DeFi: `KletiaArcSwap`, `KletiaArcLending` and `KletiaArcStaking`.
- Payments: `KletiaArcBatchPay`, `KletiaArcMemoTransfer` and `KletiaArcAgentRegistry`.
- `contracts/legacy/`: old OTC contracts, kept only for deployment provenance.

## Setup

```bash
npm ci --legacy-peer-deps
npm run compile
```
*Note: Contracts are compiled using Hardhat and Solidity 0.8.24 with `evmVersion: cancun`.*

## Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile the contracts. |
| `npm test` | Run the DeFi, Vault V2, AgentRegistry and payment tests on the in-memory Hardhat network. |
| `npm run reserves:status` | Read Arc reserve coverage without a signer. |
| `npm run reconcile:reserves` | Recalculate and fund liabilities (sends transactions). |
| `npm run deploy:vault-v2` | Reproduce the Vault V2 deployment on Arc Testnet. |

## Environment

- `ARC_PRIVATE_KEY`: needed for funding commands such as `reconcile:reserves`; it is also the Vault and Staking owner. Never expose it to the web app.
- `ARCSCAN_API_KEY`: verifies exact source and constructor arguments on ArcScan.

## Deployment

Contracts are deployed to the **Arc Testnet (Chain ID 5042002)**. Canonical contract addresses, runtime code hashes, and explorer verification states are recorded in [`deployments/arc-testnet.json`](deployments/arc-testnet.json). Migration paths for the Vault are detailed in [`VAULT_V2_MIGRATION.md`](VAULT_V2_MIGRATION.md).

Compilation and Testnet deployment evidence do not establish audit or Mainnet readiness. `reserves:status` reports observed coverage at the queried block; it is not a future funding guarantee.

Test-only receiver, token and oracle fixtures live in `contracts/test/`. The
suite exercises successful operations and adversarial rollback, solvency,
authorization, reentrancy, signature/replay and oracle-failure cases of the
deployed sources. Tests named "characterizes current deployment" document known
limitations of the deployed Swap, Staking and Lending contracts on this testnet
(no swap minimum output or deadline, APR changes that reprice uncheckpointed
rewards, a stale TWAP usable after an oracle outage); they pass because the
contracts behave that way today. Local fixtures do not replace deployed identity
validation, pinned-fork tests or funded evidence.

## License

MIT
