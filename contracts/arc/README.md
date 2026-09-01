# Kletia Contracts — Arc Testnet (@kletia/contracts-arc)

The Arc-specific Solidity workspace for contracts deployed on Arc Testnet (`5042002`). This includes the Kletia application token (KLET), solvency-guaranteed savings (KletiaArcVaultV2), and Arc-native DeFi primitives (Swap, Lending, Staking). The network leverages `KletiaArcForwarder` as a shared ERC-2771 trust root for gasless operations.

## Architecture Overview

- **`KletiaArcVaultV2`**: Active new-deposit Vault that enforces aggregate principal and interest liabilities.
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
| `npm test` | Run the test suite. |
| `npm run reserves:status` | Read-only check to calculate Arc reserves without a signer. |
| `npm run reconcile:reserves` | Write-path operation to recalculate and fund liabilities. |
| `npm run deploy:vault-v2` | Reproduce the Vault V2 deployment on Arc Testnet. |

## Key Environment Variables

- `ARC_PRIVATE_KEY`: Required for funding commands (e.g., `reconcile:reserves`) and acts as the Vault/Staking owner. This must never be exposed to the web application.
- `ARCSCAN_API_KEY`: Used to verify exact source and constructor arguments on ArcScan.

## Deployment Information

Contracts are deployed to the **Arc Testnet (Chain ID 5042002)**. Canonical contract addresses, runtime code hashes, and live explorer verification states are recorded in `deployments/arc-testnet.json`. Migration paths for the Vault are detailed in `VAULT_V2_MIGRATION.md`.

## License

MIT
