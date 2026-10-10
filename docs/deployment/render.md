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

`npm ci` runs the root `postinstall`, which builds `@kletia/core`, `@kletia/sdk`, `@kletia/widget` and `@kletia/cli` before the applications.

## Public pages and files on the static site

The static site serves four kinds of public page besides the app. Their
rules live in `render.yaml` (`routes` and `headers` of `kletia-frontend`):

| Path | Served by | Rules |
|---|---|---|
| `/go/<linkId>` | Rewrite to `https://api.kletiaai.xyz/v1/links/<linkId>/page` | The API returns this site's `go-shell.html` with the link's title, description and share card injected between `<!--kletia:head-->` markers (crawlers do not run JavaScript). `X-Frame-Options: DENY` and `frame-ancestors 'none'`: an intent link page is never framed. The page says `noindex,nofollow` in its meta tag. |
| `/go/<linkId>/card.png` | Rewrite to `…/v1/links/<linkId>/card.png` | The share card. Listed before `/go/:id` (first match wins). No `X-Robots-Tag`, so link previews can fetch it. |
| `/r/<receiptId>` | The app (`/index.html`) | Shared receipts: `X-Frame-Options: SAMEORIGIN`, `X-Robots-Tag: noindex, nofollow`, `Disallow: /r/` in `robots.txt`. The share key stays in the fragment (`#s=…&k=…`), which never reaches a server. |
| `/approve#apr_…` | The app | Rule Book approvals: `SAMEORIGIN`, `noindex`, `Disallow: /approve`. The approval id stays in the fragment. |
| `/actions.json` | File (`apps/web/public/actions.json`) | Maps `/go/*` to `https://api.kletiaai.xyz/v1/blinks/*` for Solana Actions clients, with the Actions CORS headers. |
| `/.well-known/kletia-receipt-keys.json` | File | The second origin of the receipt key set: verifiers trust a key only when the API (`GET /v1/receipts/keys`) and this file both list it. `Access-Control-Allow-Origin: *`, `application/json`, one hour of cache. |
| `/go-shell.html` | File | The shell the API reads for link pages (`KLETIA_WEB_ORIGIN/go-shell.html`); it loads the current entry, styles and fonts from this origin's `/index.html`, so it never goes stale after a release. `no-cache`. |

Render applies a rewrite only when no file exists at the path, and a rewrite
to a full URL proxies (the browser stays on `kletiaai.xyz/go/…`). Whether
Render forwards the API's own response headers through a rewrite is not
documented, so the framing headers above are also set as static-site rules.
A static site cannot answer a CORS preflight; Actions clients read
`actions.json` with a simple `GET`, which the `Access-Control-Allow-Origin: *`
header covers.

The receipt key mirror ships empty until the operator generates the
production receipt key. Rotation and the first key follow the same rule:
add the public key to `apps/web/public/.well-known/kletia-receipt-keys.json`
(the exact JSON `GET /v1/receipts/keys` returns, `keys` and `attesters`) in
the release that sets `KLETIA_RECEIPT_SIGNING_KEY`; until both origins list a
key, receipt pages and `kletia receipt verify` refuse it (`KEY_UNKNOWN`).

## Domains

- frontend: `https://kletiaai.xyz`
- API: `https://api.kletiaai.xyz`

Keep the Render subdomains available until custom-domain DNS, TLS, CORS and wallet flows have passed. If Cloudflare is used, begin in DNS-only mode; another proxy requires a fresh `TRUST_PROXY_HOPS` and rate-limit spoof review.

`/api` accepts browser requests only from the committed origins and `CORS_ORIGINS`. `/v1` accepts any origin without credentials, because integrators authenticate with API keys rather than cookies.

## Server-only environment

These values belong only to the API service:

- `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL`, `SOLANA_RPC_URL`
- `ETHEREUM_RPC_URL`, `OPTIMISM_RPC_URL`, `POLYGON_RPC_URL` (intent-platform networks; keyless public RPCs when unset)
- `OPENROUTER_API_KEY`, `WEBACY_API_KEY`, `ALLORA_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`
- `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID`, `RELAY_API_KEY`, `LIFI_API_KEY`, `DEBRIDGE_ACCESS_TOKEN`
- `KLETIA_WEB_ORIGIN` (error docs and MCP hand-off links) and the optional `KLETIA_MCP_ALLOWED_ORIGINS`
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
9. `curl -sI https://kletiaai.xyz/go/<a link id>` shows `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and an HTML body whose `<title>` names the link; `/go/<id>/card.png` answers `image/png`. `curl -s https://kletiaai.xyz/actions.json` returns the `/v1/blinks/*` rule with `Access-Control-Allow-Origin: *`; `curl -sI https://kletiaai.xyz/.well-known/kletia-receipt-keys.json` shows `application/json` and `Access-Control-Allow-Origin: *`; `/r/<id>` and `/approve` show `X-Robots-Tag: noindex, nofollow`.
10. Switching Base → Arbitrum → Solana → Arc in the console clears stale executable state; EVM and Solana wallets stay connected independently.
11. Test one read-only intent on every enabled network before a value-bearing intent.
12. Verify value-bearing operations by receipt, settlement and protocol state, not only by a hash.
13. Confirm no server secret appears in the static bundle.

## Evidence language

- A successful build proves buildability.
- Live readiness proves observed identities and dependencies.
- A Testnet transaction proves only that exact Testnet operation.
- A settled cross-network step proves that exact fill, not the safety of the settlement network.
- No local or Testnet result is a security audit or Mainnet production claim.
