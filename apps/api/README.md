# Kletia API (@kletia/api)

The intent API behind the Kletia app. It turns natural language into structured execution plans and serves Base Mainnet, Arc Testnet, capability-gated Arbitrum One, Arbitrum Sepolia and Solana through one HTTP boundary. Each network keeps its own chain identity, assets, protocol targets, transaction builders and runtime validation. Every transaction is built deterministically and signed in the user's own wallet.

## Layout

- `src/networks/`: chain handlers and readiness checks, one folder per network.
  - `base`: Base DeFi through Intent Router V2, lending, Basenames, token launch, portfolio, paymaster, and x402 micropayments.
  - `arc`: Arc programmable money intents (dashboard, lending, swap, vault, staking, batch, memo) and Circle App Kit integration.
  - `arbitrum`: reviewed Arbitrum assets, Uniswap V3 and Aave V3 actions.
  - `arbitrum-sepolia`: Circle USDC/CCTP and Aave Testnet execution endpoint (`/api/arbitrum-sepolia`).
  - `solana`: Solana mainnet and devnet portfolio, Jupiter swaps, and Kamino yield data (`/api/solana`).
- `src/cross-chain/`: the sealed `WorkflowPlanV1` engine for Base to Arbitrum Across workflows (`/api/workflows/advance`, `/api/workflows/resume`). Each step is prepared only after the preceding onchain receipt is verified.
- `src/shared/`: parsing, entity resolution, HTTP middleware, response envelopes, privacy traces, observability, and safety gates.
- `src/integrations/`: bounded HTTP routes for external providers (Allora, Webacy).
- `src/release/`: live, mock-free readiness report (`/api/release/mvp-readiness`).
- `src/scripts/`: operator-only verification, evidence, cleanup, and reserve commands (excluded from production builds).

## Setup

```bash
npm ci --legacy-peer-deps
```

## Scripts

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

## Environment

[`.env.example`](.env.example) lists every environment variable; they control network readiness, execution limits and external services. `OPENROUTER_API_KEY` is optional: deterministic parsing works without the model fallback. Solana uses `SOLANA_RPC_URL` and `SOLANA_DEVNET_RPC_URL` (configure a private RPC provider in production) and optionally `JUPITER_API_KEY`. Private keys are kept out of the runtime configuration and belong only in operator environments.

## Deployment

This package operates as a Node.js (Express 5) service. The committed [`.npmrc`](.npmrc) keeps build dependencies available during package-local CI installation; production starts only the emitted `dist/index.js` output.

## License

MIT
