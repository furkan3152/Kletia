# Kletia API (@kletia/api)

The canonical intent-driven API for the unified Kletia application. It converts natural language into structured execution plans and serves Base Mainnet, Arc Testnet, capability-gated Arbitrum One, Arbitrum Sepolia, and Solana through a single HTTP boundary. Each network keeps its own chain identity, assets, protocol targets, transaction builders, and runtime validation; every transaction is built deterministically and signed in the user's own wallet.

## Architecture Overview

- **`src/index.ts`, `src/http/`**: Entry point, Express composition (helmet, CORS, `/v1` mount, `/api` limiters) and server lifecycle (startup attestation, degraded mode, shutdown).
- **`src/platform/`**: The cross-network intent engine (grammar, planner, Jupiter / Relay / Aave V3 / transfer adapters, on-chain and settlement verification, Postgres or memory store, settlement poller) and the public Platform API v1 (`/v1`: keys, tier limits, intents, Server-Sent Events, signed webhooks, OpenAPI). See [`docs/platform/api-v1.md`](../../docs/platform/api-v1.md).
- **`src/networks/`**: Independent chain handlers and readiness boundaries.
  - `base`: Base DeFi via Intent Router V2, lending, Basenames, token launch, portfolio, paymaster, and x402 micropayments.
  - `arc`: Arc programmable money intents (dashboard, lending, swap, vault, staking, batch, memo) and Circle App Kit integration.
  - `arbitrum`: Reviewed Arbitrum assets, Uniswap V3 and Aave V3 actions.
  - `arbitrum-sepolia`: Circle USDC/CCTP and Aave Testnet execution endpoint (`/api/arbitrum-sepolia`).
  - `solana`: Solana mainnet and devnet portfolio, Jupiter swaps, and Kamino yield data (`/api/solana`).
- **`src/cross-chain/`**: The sealed `WorkflowPlanV1` engine for Base to Arbitrum Across workflows (`/api/workflows/advance`, `/api/workflows/resume`). Each step is prepared only after the preceding onchain receipt is verified.
- **`src/shared/`**: Parsing, entity resolution, HTTP middleware, response envelopes, privacy traces, observability, and safety gates.
- **`src/integrations/`**: Bounded HTTP routes for external providers like Allora and Webacy.
- **`src/release/`**: Live, mock-free readiness report (`/api/release/mvp-readiness`).
- **`src/scripts/`**: Operator-only verification, evidence, cleanup, and reserve commands (excluded from production builds).

## Setup Instructions

The API is part of the root npm workspace. Install once from the repository root:

```bash
npm ci                 # from the repository root; also builds @kletia/core, sdk and widget
npm run dev:api        # from the root, or `npm run dev` here
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the package development server using `tsx`. |
| `npm run dev:mvp` | Start the fail-closed local MVP profile used by the root `dev:mvp:api` command. |
| `npm run build` | Clean `dist` and compile the TypeScript source. |
| `npm start` | Run the compiled output in `dist/index.js`. |
| `npm run typecheck` | Verify types across the package. |
| `npm test` | Run the platform engine and Platform API tests (`test:platform`). Set `KLETIA_TEST_DATABASE_URL` to also run the PostgreSQL store contract. |
| `npm run release:preflight` | Typecheck, build, and verify the Base registry. |
| `npm run verify:intent-schema-planner` | Verify the structured intent schema and multi-step workflow gates. |
| `npm run verify:intent-network-matrix` | Verify deterministic and prompt-bound AI intent parsing across Base, Arc, and Arbitrum. |
| `npm run verify:mvp-live` | Run the live readiness report against the configured RPC endpoints. |

## Key Environment Variables

Please see [`.env.example`](.env.example) for the complete list of environment variables. Environment configuration drives network readiness, execution limits, and external service bindings. `OPENROUTER_API_KEY` is optional; deterministic parsing remains available without semantic-model fallback. Solana uses `SOLANA_RPC_URL` and `SOLANA_DEVNET_RPC_URL` (configure a private RPC provider in production) and optionally `JUPITER_API_KEY`. Private keys are deliberately isolated from the runtime configuration and belong only to operator-specific environments.

## Deployment Information

This package operates as a Node.js (Express 5) service built from the workspace root (`npm run build:api`, `npm run start:api`). Production starts only the emitted `dist/index.js` output; settlement polling and webhook delivery run in that long-lived process. See [Render](../../docs/deployment/render.md) and [Vercel](../../docs/deployment/vercel.md).

## License

MIT
