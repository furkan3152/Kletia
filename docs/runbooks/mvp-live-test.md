# Kletia real-data test runbook

This runbook defines how to test Kletia end to end without mock quotes, placeholder contracts or silent transaction retries.

## What is in scope

- Base Mainnet: Intent Router V2 swaps, LaunchFactory V2, Relay swaps and bridges, Aave V3 supply.
- Arbitrum One: Uniswap V3 / Aave V3 and Relay swaps and bridges.
- Solana (primary network): Jupiter, Raydium and Orca swaps and liquid staking, SOL/SPL transfers, Relay bridges to and from Base and Arbitrum.
- Ethereum: SparkLend USDC/WETH and Yearn V3 USDC-1 deposits and withdrawals.
- Arc Testnet: reviewed DeFi V2 sources for swap/lending/staking (new deployment required), Vault V2, memo and batch payments.
- Arbitrum Sepolia: Circle Testnet USDC and Aave supply.
- Platform API v1: intent planning, step preparation, on-chain verification, settlement polling, SSE and webhooks.

## 1. Static release verification

```bash
nvm use
npm ci
KLETIA_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/kletia_test npm run verify
npx playwright install chromium
npm run test:e2e
```

This verifies repository boundaries, package tests, privacy egress, intent/network binding, typechecks, builds, lint, contract compilation, exact Arc runtime pins and local contract regressions. Browser fixtures cover project isolation and review boundaries without signing. It is not a funded transaction.

## 2. Live no-mock preflight

```bash
npm run verify:mvp-live
```

The same report is served while the API runs at `GET /api/release/mvp-readiness`. It checks Base, Arc, Arbitrum Sepolia and Solana identities and RPCs. Solana RPC is required because it is the primary product network. Arc DeFi requires separate V2 deployments and exact source/runtime identity; unconfigured deployments intentionally block this full preflight. HTTP 503 or a non-zero exit is correct while a required surface is missing. `GET /api/capabilities` shows which optional features need operator configuration.

## 3. Run locally

```bash
npm run dev:api     # http://localhost:3001
npm run dev:web     # http://localhost:5174
```

No operator private key is injected; every approval and money movement is signed in the user's own EVM or Solana wallet.

## 4. Platform API smoke (no funds)

```bash
curl -s localhost:3001/v1/health
curl -s localhost:3001/v1/networks
curl -s -X POST 'localhost:3001/v1/intents?dryRun=true' -H 'content-type: application/json' \
  -d '{"text":"bridge 25 USDC from base to solana then swap half to JitoSOL","accounts":["eip155:8453:0x000000000000000000000000000000000000dEaD","solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]}'
```

Expect a planned graph with live Relay and Jupiter quotes. Unsupported wording must return `422 INTENT_UNSUPPORTED` with examples.

## 5. User-signed smoke (small amounts)

Use your own wallets and the smallest practical amounts.

1. **Solana swap** — in the console Solana workspace or Studio, swap 0.01 SOL to USDC. Verify the signature reaches `confirmed`, the activity feed records it and the portfolio refreshes.
2. **Solana transfer** — send 0.1 USDC to a second wallet you own; the recipient's associated token account is created idempotently.
3. **Cross-network** — run `bridge 1 USDC from base to solana` through Studio or the SDK. The step must move `submitted → settling → settled` only after Relay reports the destination fill; the destination transaction appears as evidence.
4. **Dependent step** — run `bridge 2 USDC from base to solana then swap half to JitoSOL`. Step 2 must stay `pending` until step 1 settles.
5. **EVM swap** — swap a small amount on Base through the console; the pre-sign screening and simulation must pass before the wallet prompt.
6. **Recovery** — interrupt a submission (close the tab after signing). Refresh the intent: the existing reference must be recovered and verified, never resent.

## 6. Other funded checks

Base x402 requires a real, deliberately small EIP-3009 payment. Success requires both the exact `AuthorizationUsed` nonce and the expected USDC `Transfer`; an indeterminate result is recovered rather than retried.

## Honest completion boundary

A green static verification proves the code boundary. A green live preflight proves configured dependencies are reachable and identity-bound. Only user-signed evidence proves a lifecycle, and only for the exact operations performed. None of these is a production audit or a mainnet safety claim.
