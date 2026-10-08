# Kletia API (@kletia/api)

The canonical intent-driven API for the unified Kletia application. It converts natural language into structured execution plans and serves Base Mainnet, Arc Testnet, capability-gated Arbitrum One, Arbitrum Sepolia, and Solana through a single HTTP boundary. Each network keeps its own chain identity, assets, protocol targets, transaction builders, and runtime validation; every transaction is built deterministically and signed in the user's own wallet.

## Architecture Overview

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
| `npm run verify:intent-schema-planner` | Verify the structured intent schema and multi-step workflow gates. |
| `npm run verify:intent-network-matrix` | Verify deterministic and prompt-bound AI intent parsing across Base, Arc, and Arbitrum. |
| `npm run verify:mvp-live` | Run the live readiness report against the configured RPC endpoints. |

## Key Environment Variables

Please see [`.env.example`](.env.example) for the complete list of environment variables. Environment configuration drives network readiness, execution limits, and external service bindings. `OPENROUTER_API_KEY` is optional; deterministic parsing remains available without semantic-model fallback. Solana uses `SOLANA_RPC_URL` and `SOLANA_DEVNET_RPC_URL` (configure a private RPC provider in production) and optionally `JUPITER_API_KEY`. Private keys are deliberately isolated from the runtime configuration and belong only to operator-specific environments.

## Deployment Information

This package operates as a Node.js (Express 5) service. The committed [`.npmrc`](.npmrc) keeps build dependencies available during package-local CI installation; production starts only the emitted `dist/index.js` output.

## License

MIT
