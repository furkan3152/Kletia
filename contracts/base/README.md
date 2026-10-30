# Kletia contracts for Base Mainnet (@kletia/contracts-base)

Solidity workspace for Kletia's contracts on Base: the intent routers, typed
protocol adapters (Uniswap V2/V3 and others), the Safe-governed token launch
factory (KletiaLaunchFactoryV2) and the x402 payment contracts.

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

| Command | What it does |
|---------|-------------|
| `npm run compile` | Compile with the pinned Solidity 0.8.24 and 0.8.20 profiles. |
| `npm test` | Run the router settlement, launch factory and typed adapter tests on the in-memory Hardhat network. |
| `npm run verify:x402-factory` | Read-only exact-match verification of the deployed Factory. |
| `npm run verify:v2:blockscout` | Verify the active V2 Router runtime against Blockscout. |
| `npm run deploy:v2:direct-safe` | Deploy the active Intent Router V2 through the direct Safe. |
| `npm run evidence:v2:base:deployment` | Export runtime evidence for the live Base deployment. |

## Environment

- Safe owner keys stay in the ignored package-local `.env` used for deployments.
- `BASESCAN_API_KEY`: only needed to submit self-attribution to BaseScan.

## Deployments

These contracts target Base Mainnet (chain ID 8453) and are governed by a
2-of-2 Safe. Most sources compile with Solidity 0.8.24/Cancun; the x402 Factory
and Gateway keep their exact 0.8.20/Paris deployment profile. Active addresses
and identities are in
[`deployments/base-mainnet-v2.json`](deployments/base-mainnet-v2.json).

Deployment and codehash evidence establish exact observed identity, not an independent security audit. Legacy sources remain for provenance and are not silent runtime fallbacks.

The local suite covers successful settlement and adversarial nonce, signature,
time-window, codehash/configuration, token-delta, output and approval cases, plus
deterministic launches and typed route construction. Test-only contracts in
`contracts/test/` are fixtures, not deployment candidates. These tests do not
replace pinned Mainnet fork tests, funded transaction evidence or an audit.

## License

MIT
