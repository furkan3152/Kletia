# Environment checklist (one pass)

Everything the hosted services need, in one list. Add the secrets in the Render
dashboard (Environment tab of each service; "Generate" makes a random value),
then redeploy once. Public settings (addresses, modes) are already applied by
code defaults or set on the services; this list is what only the operator can add.

## API service (`Kletia`, api.kletiaai.xyz)

### Required for a durable, production API

| Variable | What to put | How |
|---|---|---|
| `NODE_ENV` | `production` | already set |
| `KLETIA_DATABASE_URL` | PostgreSQL connection string | Create a Render PostgreSQL instance, copy its *Internal Database URL* |
| `KLETIA_PLATFORM_SECRET` | 32+ random characters | "Generate" in Render, or `openssl rand -hex 32` |
| `WORKFLOW_SIGNING_SECRET` | 32+ random characters | "Generate" in Render |
| `KLETIA_WEB_ORIGIN` | `https://kletiaai.xyz` | plain value |

### Receipts (signed, verifiable receipts)

| Variable | What to put |
|---|---|
| `KLETIA_RECEIPT_SIGNING_KEY` | Ed25519 private key (see [receipts.md](../platform/receipts.md)) |
| `KLETIA_RECEIPT_KEY_NOT_BEFORE` | ISO time the key becomes valid |
| `KLETIA_RECEIPT_PUBLIC_KEY` | the matching public key; also set on the **site** service so the build writes `/.well-known/kletia-receipt-keys.json` |

### Strongly recommended (rate limits and reliability)

| Variable | Where to get it |
|---|---|
| `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `ETHEREUM_RPC_URL`, `OPTIMISM_RPC_URL`, `POLYGON_RPC_URL`, `SOLANA_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL` | Private RPC endpoints (Alchemy, QuickNode, Helius for Solana). Public fallbacks are rate-limited. |
| `RELAY_API_KEY` | relay.link (bridges and EVM swaps) |
| `JUPITER_API_KEY` | portal.jup.ag (Solana swaps and lending) |
| `LIFI_API_KEY` | li.fi |
| `DEBRIDGE_ACCESS_TOKEN` | debridge.finance |
| `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID` | across.to |

### Optional integrations (features stay off without them)

`OPENROUTER_API_KEY` (AI parsing fallback), `WEBACY_API_KEY` (address risk), `ALLORA_API_KEY`, `ALCHEMY_API_KEY`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY` (Coinbase on-ramp),
`CDP_PAYMASTER_POLICY_ID` with `PAYMASTER_PROXY_ENABLED=true` (gas sponsorship), `X402_TREASURY_ADDRESS` (x402 premium),
`KLETIA_OPERATOR_API_KEYS` (operator tier), `KLETIA_MCP_ALLOWED_ORIGINS`, `KLETIA_EAS_ATTESTER_KEY` (optional EAS envelope).

Never set `KLETIA_REQUIRE_ALL_FEATURES=true` unless every optional key above is present: the API then refuses to start.

## Site service (`KletiaAi`, kletiaai.xyz)

| Variable | What to put |
|---|---|
| `VITE_BACKEND_URL` | `https://api.kletiaai.xyz` (already set) |
| `VITE_WALLETCONNECT_PROJECT_ID` | cloud.reown.com project id (mobile wallets) |
| `VITE_ETHEREUM_RPC_URL`, `VITE_OPTIMISM_RPC_URL`, `VITE_POLYGON_RPC_URL`, `VITE_ARBITRUM_SEPOLIA_RPC_URL` | Public, domain-restricted RPC URLs (these ship in the browser bundle: never a secret key) |
| `KLETIA_RECEIPT_PUBLIC_KEY` | same public key as the API |

`VITE_*` values are public. Never paste a server secret into the site service.

## Dashboard-only settings (once)

- Site → Redirects/Rewrites and Headers: see [render.md](render.md#services-created-in-the-dashboard).
- API → plan: the free plan sleeps after 15 idle minutes; integrators need an always-on instance.
- GitHub → repository secret `NPM_TOKEN`, then push a `v*` tag to publish the `@kletia/*` packages (`.github/workflows/release-packages.yml`).
