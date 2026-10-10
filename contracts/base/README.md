# Kletia Contracts — Base Mainnet (@kletia/contracts-base)

The Base-only Solidity workspace for Kletia's intent-native settlement architecture. This package maintains the Kletia routers, typed protocol adapters (like Uniswap V2/V3), Safe-governed token launch mechanisms (KletiaLaunchFactoryV2), and x402 micropayment implementations. 

## Architecture Overview

- **`contracts/v2/`**: Current intent-router architecture, EIP-712 settlement, and modern typed adapters.
- **`contracts/legacy/`**: Historic contracts retained purely for existing deployments and provenance.
- **`contracts/x402/`**: Base x402 seller contracts, including the Factory and Gateway deployments.
- **`deployments/`**: Public deployment manifests and runtime identities.
- **`scripts/v2/`**: Release policy tooling and runtime evidence exporters.
- **`scripts/verification/`**: Reproducible exact-source and runtime verification tooling (e.g., Blockscout/BaseScan).

## Setup Instructions

```bash
npm ci --legacy-peer-deps
npm run compile
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile contracts with pinned Solidity 0.8.24 and 0.8.20 profiles. |
| `npm test` | Run local router settlement, launch factory and typed adapter tests on the in-memory Hardhat network. |
| `npm run verify:x402-factory` | Perform read-only exact match verification of the deployed Factory. |
| `npm run verify:v2:blockscout` | Verify active V2 Router runtime against Blockscout. |
| `npm run deploy:v2:direct-safe` | Deploy the active Intent Router V2 through the direct Safe. |
| `npm run evidence:v2:base:deployment` | Export exact runtime evidence for the live Base deployment. |

## Key Environment Variables

- Safe owner keys must remain within ignored package-local environment files (`.env`) for deployment execution.
- `BASESCAN_API_KEY`: Required only if performing an active self-attribution submission to BaseScan.

## Deployment Information

Contracts in this workspace target **Base Mainnet (Chain ID 8453)** and are governed by a 2-of-2 Safe multisig. Most active sources compile with Solidity 0.8.24/Cancun; the x402 Factory and Gateway retain their exact Solidity 0.8.20/Paris deployment profile. Active public identities and canonical contract addresses are maintained in [`deployments/base-mainnet-v2.json`](deployments/base-mainnet-v2.json).

Deployment and codehash evidence establish exact observed identity, not an independent security audit. Legacy sources remain for provenance and are not silent runtime fallbacks.

The local suite covers successful settlement and adversarial nonce, signature,
time-window, codehash/configuration, token-delta, output and approval cases, plus
deterministic launches and typed route construction. Test-only contracts in
`contracts/test/` are fixtures, not deployment candidates. These tests do not
replace pinned Mainnet fork tests, funded transaction evidence or an audit.

## License

MIT
