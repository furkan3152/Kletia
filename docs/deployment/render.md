# Render deployment

`render.yaml` is the canonical public topology:

- `kletia-backend` (Web Service): the Kletia API, with console routes under `/api` and the public Platform API under `/v1`.
- `kletia-frontend` (Static Site): the web app (home, console, Studio, developer portal and network status).
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

`npm ci` runs the root `postinstall` (`tooling/postinstall-packages.mjs`), which builds the `@kletia/*` packages before the applications. A package whose build tools the install did not bring in is skipped with a message rather than failing the install; compile errors still fail.

## Services created in the dashboard

The hosted services were created in the dashboard before the repository became a workspace, with a root directory per app. They deploy as they are:

| Service | Root directory | Build | Start / publish |
|---|---|---|---|
| API (Web Service) | `apps/api` | `npm ci --legacy-peer-deps && npm run build` | `npm start` |
| Site (Static Site) | `apps/web` | `npm ci --include=dev --legacy-peer-deps && npm run build` | publish `dist` |

`npm ci` inside a workspace folder installs only that app's dependency tree, so the API install skips the widget, the embed and the CLI (it imports none of them). The services set `NODE_ENV=production`, which makes `npm ci` leave out devDependencies; the API therefore lists the tools its build needs (`typescript` and the `@types/*` packages) as dependencies. The site build writes one HTML entry per fixed route (`developers.html`, `studio.html`, `app.html`, …) with the route's title and description, so those paths load without a rewrite rule.

Three things only the dashboard can set on these services (a Blueprint sets them from `render.yaml`):

1. **Static site → Redirects/Rewrites**, in this order (the `routes` of `kletia-frontend`): `/go/:id/card.png` → `https://api.kletiaai.xyz/v1/links/:id/card.png`, `/go/:id` → `https://api.kletiaai.xyz/v1/links/:id/page`, `/*` → `/index.html`, all three as Rewrite. Without them receipt pages (`/r/<id>`), link pages (`/go/<id>`) and other deep links answer 404.
2. **Static site → Headers**: the `headers` of `kletia-frontend` in `render.yaml` (framing, `X-Robots-Tag`, CORS for `actions.json` and the receipt key mirror). The app refuses to render outside `/embed` inside a cross-origin frame even without them.
3. **API → Environment**: `NODE_ENV=production`, `KLETIA_WEB_ORIGIN=https://kletiaai.xyz`, `WORKFLOW_SIGNING_SECRET` (32+ random characters), and for durable keys, intents and webhooks a PostgreSQL `KLETIA_DATABASE_URL` with `KLETIA_PLATFORM_SECRET` (32+ characters). Without a database the API keeps everything in memory, and a free instance that sleeps loses it. The free plan also sleeps after 15 idle minutes, so the first request after that waits about a minute; integrators need an always-on instance.

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
| `/.well-known/kletia-receipt-keys.json` | File, generated by the build (`scripts/write-receipt-keys.mjs`) | The second origin of the receipt key set: verifiers trust a key only when the API (`GET /v1/receipts/keys`) and this file both list it. `Access-Control-Allow-Origin: *`, `application/json`, one hour of cache. See [The receipt key mirror](#the-receipt-key-mirror). |
| `/sdk/embed/<version>/kletia-embed.min.js`, `…/index.js` | Files, copied from `packages/embed/dist` by the build (`scripts/emit-embed-script.mjs`) | The embed script partners load with an SRI hash: `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `text/javascript`, `public, max-age=31536000, immutable` (rules `/sdk/embed/*/*.js`). |
| `/sdk/embed/manifest.json` | File, written by the same build step | The current version and the SHA-384 `integrity` of each file. `no-cache`, `Access-Control-Allow-Origin: *`. |
| `/go-shell.html` | File | The shell the API reads for link pages (`KLETIA_WEB_ORIGIN/go-shell.html`); it loads the current entry, styles and fonts from this origin's `/index.html`, so it never goes stale after a release. `no-cache`. |

Render applies a rewrite only when no file exists at the path, and a rewrite
to a full URL proxies (the browser stays on `kletiaai.xyz/go/…`). Whether
Render forwards the API's own response headers through a rewrite is not
documented, so the framing headers above are also set as static-site rules.
A static site cannot answer a CORS preflight; Actions clients read
`actions.json` with a simple `GET`, which the `Access-Control-Allow-Origin: *`
header covers.

## The receipt key mirror

The web build writes `dist/.well-known/kletia-receipt-keys.json` from the
static site's environment (`apps/web/scripts/write-receipt-keys.mjs`; the
file in `apps/web/public/` is only the empty placeholder the development
server serves). Set these on `kletia-frontend` (Static Site → Environment),
then redeploy it; they are public values:

| Variable | Value |
|---|---|
| `KLETIA_RECEIPT_PUBLIC_KEY` | The active key's public part: `{"x":"<base64url>","notBefore":"YYYY-MM-DD"}` (or the bare `x` with `KLETIA_RECEIPT_KEY_NOT_BEFORE`). `x` and `notBefore` must equal what `GET /v1/receipts/keys` lists for the API's `KLETIA_RECEIPT_SIGNING_KEY` and `KLETIA_RECEIPT_KEY_NOT_BEFORE`. |
| `KLETIA_RECEIPT_KEY_NOT_BEFORE` | Optional: the same day as on the API, for a bare `x`. |
| `KLETIA_RECEIPT_KEYSET` | Exactly the API's value (retired and revoked public keys), read the way the API reads it. |
| `KLETIA_RECEIPT_NEXT_KEY` | Optional: the announced next key, mirrored only with an explicit `notBefore`. |
| `KLETIA_RECEIPT_ATTESTERS` | Optional: the `attesters` array `GET /v1/receipts/keys` returns (EAS). |
| `KLETIA_RELEASE` | `1` makes a missing active key (or an input that had to be ignored) fail the build. Render builds run without it; the release build sets it. |

The build fails, writing nothing, when any input carries private material (a
`d` member or a PEM block), when `KLETIA_RECEIPT_SIGNING_KEY` or
`KLETIA_EAS_ATTESTER_KEY` is set on the static site at all (they belong to
the API only), when the active key has no `notBefore`, and when the active
key is also in the key set. Until both origins list a key, receipt pages and
`kletia receipt verify` refuse it (`KEY_UNKNOWN`).

Rotation, step by step:

1. Generate key B offline. Announce it: set `KLETIA_RECEIPT_NEXT_KEY` to
   `{"x":"<B>","notBefore":"<day>"}` on both services and pin B in the next
   `@kletia/core` release.
2. On the switch day: on the API set `KLETIA_RECEIPT_SIGNING_KEY` to B's seed
   and `KLETIA_RECEIPT_KEY_NOT_BEFORE` to that day, add A to
   `KLETIA_RECEIPT_KEYSET` as `retired`, and remove `KLETIA_RECEIPT_NEXT_KEY`.
3. On the static site set `KLETIA_RECEIPT_PUBLIC_KEY` to B's public part and
   the same `KLETIA_RECEIPT_KEYSET`, remove `KLETIA_RECEIPT_NEXT_KEY`, and
   redeploy. `curl -s https://kletiaai.xyz/.well-known/kletia-receipt-keys.json`
   and `curl -s https://api.kletiaai.xyz/v1/receipts/keys` must list the same
   kids, `x` and `notBefore`.
4. After a compromise on day D, add A to both key sets as `revoked` with
   `revokedOn: D` and redeploy both.

## Compression and 404s in the Docker server

`apps/web/scripts/serve-production.mjs` (Docker, `npm start` in `apps/web`)
serves the same files with the same headers, compresses text with brotli or
gzip (`Vary: Accept-Encoding`), and answers paths no route knows with the
app shell and a `404` status, decided from `dist/route-manifest.json`, which
the build writes from the route table. A static host keeps its SPA rewrite
and answers `200` there.

## Domains

- frontend: `https://kletiaai.xyz`
- API: `https://api.kletiaai.xyz`

Keep the Render subdomains available until custom-domain DNS, TLS, CORS and wallet flows have passed. If Cloudflare is used, begin in DNS-only mode; another proxy requires a fresh `TRUST_PROXY_HOPS` and rate-limit spoof review.

`/api` accepts browser requests only from the committed origins and `CORS_ORIGINS`. `/v1` accepts any origin without credentials, because integrators authenticate with API keys rather than cookies.

## Admin panel

`/admin` on the static site is the wallet-gated operator panel; its API lives under `/api/admin` on `kletia-backend`.
Sign-in accepts the EVM wallet in `KLETIA_ADMIN_ADDRESSES` (EIP-4361) or the Solana wallet in
`KLETIA_ADMIN_SOLANA_ADDRESSES` (Sign In With Solana); both are committed values in `render.yaml`. The session is a
host-only `__Host-` cookie on `api.kletiaai.xyz`, which works because `kletiaai.xyz` and `api.kletiaai.xyz` are the
same site; the panel therefore refuses `kletia-frontend.onrender.com`. The site serves `/admin` with
`X-Frame-Options: DENY`, `frame-ancestors 'none'`, `noindex` and `no-store`. Add `RENDER_API_KEY` on the API service
to enable the status and redeploy buttons. Details: [admin.md](admin.md).

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
