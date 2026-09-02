# Kletia API (@kletia/api)

The canonical intent-driven API for the unified Kletia application. It converts natural language into structured execution plans and serves Base Mainnet, Arc Testnet, capability-gated Arbitrum One, and the Stellar-centered Testnet lane through a single HTTP boundary. It maintains independent chain identity, assets, protocol targets, transaction builders, and runtime validation.

## Architecture Overview

- **`src/networks/`**: Independent chain handlers and readiness boundaries.
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
| `npm run dev` | Start the package development server using `tsx`. |
| `npm run dev:mvp` | Start the fail-closed local MVP profile used by the root `dev:mvp:api` command. |
| `npm run build` | Clean `dist` and compile the TypeScript source. |
| `npm start` | Run the compiled output in `dist/index.js`. |
| `npm run typecheck` | Verify types across the package. |
| `npm run release:preflight` | Typecheck, build, and verify the Base registry. |
| `npm run solver:testnet` | Run the Testnet reference solver. |

The reference solver belongs to the opt-in Stellar labs profile. It observes and submits bounded auction coordination records; it does not hold an Arc/EVM key or execute a user's cross-chain transaction.

## Key Environment Variables

Please see [`.env.example`](.env.example) for the complete list of environment variables. Environment configuration drives network readiness, execution limits, and external service bindings. `OPENROUTER_API_KEY` is optional; deterministic parsing remains available without semantic-model fallback. Private keys are deliberately isolated from the runtime configuration and belong only to operator-specific environments.

## Deployment Information

This package operates as a Node.js (Express 5) service. The committed [`.npmrc`](.npmrc) keeps build dependencies available during package-local CI installation; production starts only the emitted `dist/index.js` output. The default public profile keeps `STELLAR_LABS_ENABLED=false`.

## License

MIT
