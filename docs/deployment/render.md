# Render deployment

`render.yaml` is the canonical public topology:

- `kletia-backend` (Web Service): the Kletia API — console routes under `/api` and the public Platform API under `/v1`.
- `kletia-frontend` (Static Site): the web app — home, console, Studio, developer portal and network status.
- `kletia-stellar-event-archive` (PostgreSQL): durable store for platform intents, developer keys and webhooks (`KLETIA_DATABASE_URL`). The resource keeps its original name so the existing instance is reused instead of a new one being provisioned.

Both services deploy from `main` only after CI passes (`autoDeployTrigger: checksPass`).

## What the Blueprint enables

- Base Mainnet: Intent Router V2 swaps, LaunchFactory V2 token launch, lending discovery, Basenames, x402.
- Arbitrum One: Uniswap V3 / Aave V3 and staged Base → Arbitrum workflows (`ARBITRUM_MVP_ENABLED=true`).
- Arc Testnet: Vault V2 and the native-USDC protocol suite.
- Arbitrum Sepolia: Circle Testnet USDC and Aave supply.
- Solana: Jupiter swaps, liquid staking, transfers, Kamino discovery and Relay settlement to and from Base and Arbitrum.
- Platform API v1 with durable storage, developer keys, SSE and signed webhooks.

Public, identity-pinned deployment identities (Intent Router V2, LaunchFactory V2, Arc Vault V2) are also applied as code defaults when unset; every request re-validates them on-chain. The hosted service sets `KLETIA_REQUIRE_ALL_FEATURES=true`, so it refuses to start without its integration keys; self-hosted deployments may omit optional keys and run with those features reported as `needs_configuration` by `GET /api/capabilities`.

## Build commands

The repository is an npm workspace, so both services build from the repository root (no `rootDir`).

Backend Web Service:

- build: `npm ci --include=dev && npm run build:api`
- start: `npm run start:api` (runs the emitted `apps/api/dist/index.js`)
- health path: `/health`
- Node: `22.23.1`

Frontend Static Site:

- build: `npm ci --include=dev && npm run build:web`
- publish directory: `./apps/web/dist`
- SPA rewrite: `/*` → `/index.html`
- Node: `22.23.1`

`npm ci` runs the root `postinstall`, which builds `@kletia/core`, `@kletia/sdk` and `@kletia/widget` before the applications.

## Domains

- frontend: `https://kletiaai.xyz`
- API: `https://api.kletiaai.xyz`

Keep the Render subdomains available until custom-domain DNS, TLS, CORS and wallet flows have passed. If Cloudflare is used, begin in DNS-only mode; another proxy requires a fresh `TRUST_PROXY_HOPS` and rate-limit spoof review.

`/api` accepts browser requests only from the committed origins and `CORS_ORIGINS`. `/v1` accepts any origin without credentials, because integrators authenticate with API keys rather than cookies.

## Server-only environment

These values belong only to the API service:

- `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL`, `SOLANA_RPC_URL`
- `OPENROUTER_API_KEY`, `WEBACY_API_KEY`, `ALLORA_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`
- `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID`, `RELAY_API_KEY`
- Coinbase/CDP credentials for the on-ramp, x402 facilitator and paymaster
- `X402_TREASURY_ADDRESS`
- `KLETIA_DATABASE_URL`, `KLETIA_PLATFORM_SECRET` (webhook secret encryption), `KLETIA_OPERATOR_API_KEYS`, `WORKFLOW_SIGNING_SECRET`

Never upload a private key, deployer identity or user recovery material. The application prepares and verifies operations; users authorize every money movement in their own wallet.

## Local and CI gates

```bash
nvm use
npm ci
npm --prefix contracts/base ci --include=dev --legacy-peer-deps
npm --prefix contracts/arc ci --include=dev --legacy-peer-deps
npm run verify
npm run verify:mvp-live
```

`verify:mvp-live` may exit non-zero when a live dependency is not configured. It must still report every check independently. CI also rejects high-severity production advisories in the workspace and both contract packages; a major dependency migration is never an automatic audit fix.

## Public rollout verification

After CI succeeds and Render deploys the exact commit:

1. `/health` returns 200 without an RPC request.
2. `/api/health/base`, `/arc` and `/arbitrum` report chains `8453`, `5042002` and `42161`.
3. `/api/solana/health` reports mainnet and devnet RPC health.
4. `/api/capabilities` lists every feature as `live` (hosted deployment).
5. `/v1/health`, `/v1/networks` and `/v1/openapi.json` respond; a dry-run `POST /v1/intents` plans an example intent.
6. `/api/release/mvp-readiness` reports every check without turning an unavailable dependency green.
7. `https://kletiaai.xyz`, `/developers`, `/networks`, `/studio`, `/embed` and `/app` load without localhost requests.
8. `curl -sI https://kletiaai.xyz/embed` shows `Content-Security-Policy: frame-ancestors *` and no `X-Frame-Options`; `curl -sI https://kletiaai.xyz/app` shows `X-Frame-Options: SAMEORIGIN`. Only `/embed` may be framed by other sites; the app also refuses to render any other page inside a cross-origin frame.
9. Switching Base → Arbitrum → Solana → Arc in the console clears stale executable state; EVM and Solana wallets stay connected independently.
10. Test one read-only intent on every enabled network before a value-bearing intent.
11. Verify value-bearing operations by receipt, settlement and protocol state, not only by a hash.
12. Confirm no server secret appears in the static bundle.

## Evidence language

- A successful build proves buildability.
- Live readiness proves observed identities and dependencies.
- A Testnet transaction proves only that exact Testnet operation.
- A settled cross-network step proves that exact fill, not the safety of the settlement network.
- No local or Testnet result is a security audit or Mainnet production claim.
