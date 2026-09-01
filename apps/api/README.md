# Kletia API (@kletia/api)

The canonical intent-driven API for the unified Kletia application. It converts natural language into structured execution plans and serves Base Mainnet, Arc Testnet, capability-gated Arbitrum One, and the Stellar-centered Testnet lane through a single HTTP boundary. It maintains independent chain identity, assets, protocol targets, transaction builders, and runtime validation.

## Architecture Overview

- **`src/networks/`**: Independent chain handlers.
  - `base`: Base DeFi, Basenames, token launch, paymaster, and x402 micropayments.
  - `arc`: Arc programmable money intents, contracts, and Circle App Kit integration.
  - `arbitrum`: Reviewed Arbitrum assets, Uniswap V3, Aave V3 actions.
  - `stellar`: Native Testnet tools, passkey Payment Center (SEP-38/24/45).
- **`src/cross-chain/`**: V2, V3, and V4 compilers managing heterogeneous CCTP workflows with exact lane, wallet, asset, and privacy bindings.
- **`src/shared/`**: Parsing, entity resolution, HTTP middleware, response envelopes, observability, and safety gates.
- **`src/integrations/`**: Bounded HTTP routes for external providers like Allora and Webacy.
- **`src/scripts/`**: Operator-only verification, evidence, cleanup, and reserve commands (excluded from production builds).

## Setup Instructions

```bash
npm ci --legacy-peer-deps
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the development server using `tsx`. |
| `npm run build` | Clean `dist` and compile the TypeScript source. |
| `npm start` | Run the compiled output in `dist/index.js`. |
| `npm run typecheck` | Verify types across the package. |
| `npm run release:preflight` | Typecheck, build, and verify the Base registry. |
| `npm run solver:testnet` | Run the Testnet reference solver. |

## Key Environment Variables

Please see `.env.example` for the complete list of environment variables. Environment configuration drives network readiness, execution limits, and external service bindings. Private keys are deliberately isolated from the runtime configuration and belong only to operator-specific environments.

## Deployment Information

This package operates as a Node.js (Express 5) service. The committed `.npmrc` ensures that TypeScript remains available for production CI builds, yet the runtime itself only launches the emitted output inside the `dist` folder. 

## License

MIT
