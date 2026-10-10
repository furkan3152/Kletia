# Kletia Contracts — Arc Testnet (@kletia/contracts-arc)

The Arc-specific Solidity workspace for contracts deployed on Arc Testnet (`5042002`). This includes the Kletia application token (KLET), solvency-guaranteed savings (KletiaArcVaultV2), and Arc-native DeFi primitives (Swap, Lending, Staking). The network leverages `KletiaArcForwarder` as a shared ERC-2771 trust root for gasless operations.

## Architecture Overview

- **`KletiaArcVaultV2`**: Active new-deposit Vault that enforces aggregate principal and interest liabilities.
- **DeFi V2 sources**: `KletiaArcSwapV2`, `KletiaArcStakingV2` and `KletiaArcLendingV2` correct swap bounds, APR checkpoints and oracle failure behavior. They require separate deployment evidence before new-capital execution can be enabled; see [`DEFI_V2_MIGRATION.md`](DEFI_V2_MIGRATION.md).
- **Arc DeFi Suite**: Contracts including `KletiaArcSwap`, `KletiaArcLending`, and `KletiaArcStaking`.
- **Payment Primitives**: `KletiaArcBatchPay`, `KletiaArcMemoTransfer`, and `KletiaArcAgentRegistry`.
- **`contracts/legacy/`**: Historic OTC contracts preserved solely for deployment provenance.

## Setup Instructions

```bash
npm ci --legacy-peer-deps
npm run compile
```
*Note: Contracts are compiled using Hardhat and Solidity 0.8.24 with `evmVersion: cancun`.*

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile the Solidity contracts. |
| `npm test` | Run local DeFi, Vault V2, AgentRegistry and payment tests on the in-memory Hardhat network. |
| `npm run reserves:status` | Read-only check to calculate Arc reserves without a signer. |
| `npm run reconcile:reserves` | Write-path operation to recalculate and fund liabilities. |
| `npm run deploy:vault-v2` | Reproduce the Vault V2 deployment on Arc Testnet. |

## Key Environment Variables

- `ARC_PRIVATE_KEY`: Required for funding commands (e.g., `reconcile:reserves`) and acts as the Vault/Staking owner. This must never be exposed to the web application.
- `ARCSCAN_API_KEY`: Used to verify exact source and constructor arguments on ArcScan.

## Deployment Information

Contracts are deployed to the **Arc Testnet (Chain ID 5042002)**. Canonical contract addresses, runtime code hashes, and explorer verification states are recorded in [`deployments/arc-testnet.json`](deployments/arc-testnet.json). Migration paths for the Vault are detailed in [`VAULT_V2_MIGRATION.md`](VAULT_V2_MIGRATION.md).

Compilation and Testnet deployment evidence do not establish audit or Mainnet readiness. `reserves:status` reports observed coverage at the queried block; it is not a future funding guarantee.

Test-only receiver, token and oracle fixtures live in `contracts/test/`. The
suite exercises successful operations and adversarial rollback, solvency,
authorization, reentrancy, signature/replay, swap-bound, APR and oracle-failure
cases. Runtime identity tests compare actual local V2 deployments with the API's
reviewed source hashes and reject changed forwarder or token bindings.
Legacy characterization tests document existing limitations; the V2
regression tests verify the separate source fixes. Local fixtures do not replace
deployed identity validation, pinned-fork tests or funded evidence.

## License

MIT
