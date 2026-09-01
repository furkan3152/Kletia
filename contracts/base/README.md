# Kletia contracts for Base Mainnet (@kletia/contracts-base)

The Base-only Solidity workspace for Kletia's intent-native settlement architecture. This package maintains the Kletia routers, typed protocol adapters (like Uniswap V2/V3), Safe-governed token launch mechanisms (KletiaLaunchFactoryV2), and x402 micropayment implementations. 

## Layout

- `contracts/v2/`: the current intent router, EIP-712 settlement and typed adapters.
- `contracts/legacy/`: older contracts, kept only for existing deployments and provenance.
- `contracts/x402/`: the Base x402 seller contracts (Factory and Gateway).
- `deployments/`: public deployment manifests and runtime identities.
- `scripts/v2/`: release policy checks and runtime evidence exporters.
- `scripts/verification/`: reproducible exact-source and runtime verification (Blockscout, BaseScan).

## Setup

```bash
npm ci --legacy-peer-deps
npm run compile
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile contracts using Hardhat and Solidity 0.8.20. |
| `npm run verify:x402-factory` | Read-only exact-match verification of the deployed Factory. |
| `npm run verify:v2:blockscout` | Verify the active V2 Router runtime against Blockscout. |
| `npm run deploy:v2:direct-safe` | Deploy the active Intent Router V2 through the direct Safe. |
| `npm run evidence:v2:base:deployment` | Export runtime evidence for the live Base deployment. |

## Environment

- Safe owner keys stay in the ignored package-local `.env` used for deployments.
- `BASESCAN_API_KEY`: only needed to submit self-attribution to BaseScan.

## Deployment

Contracts in this workspace target **Base Mainnet (Chain ID 8453)** and are governed by a 2-of-2 Gnosis Safe multisig. Active public identities and canonical contract addresses are maintained in `deployments/base-mainnet-v2.json`.

## License

MIT
