# Kletia Render Deployment

Kletia is deployed as two Render services from one repository. These are not
separate Base and Arc applications:

- `apps/web` is the canonical unified Base Mainnet + Arc Testnet
  React interface. The current Render deployment uses a Node Web Service and
  serves its production `dist` directory with `scripts/serve-production.mjs`.
- `apps/api` is the canonical unified Base Mainnet + Arc Testnet
  omni-engine.
- `contracts/base` and `contracts/arc` are source/deployment workspaces, not
  Render services.

If the frontend and backend services already exist in Render, do not create a
second Blueprint or duplicate services. Update those two existing services in
place with the root directories, commands, health checks, and environment
values below. The Blueprint is the source-of-truth template and is intended for
a new installation or an existing Blueprint-managed deployment.

## New installation: deploy the Blueprint

Create a Render Blueprint and select the repository-root `render.yaml`. It
creates both services with their correct root directories, commands, domains,
environment boundaries, and frontend SPA rewrite.

Do not select a JavaScript entry file when using the Blueprint:

- Backend runtime: Node, root directory `apps/api`. Build command is
  `npm ci --include=dev --legacy-peer-deps && npm run build`; start command is `npm start`
  (`dist/index.js`).
- Frontend runtime: Node Web Service, root directory `apps/web`.
  Build command is `npm ci --include=dev --legacy-peer-deps && npm run build`; start command
  is `npm start` (`scripts/serve-production.mjs`).

## Manual service creation (only if Blueprint is not used)

Backend Web Service:

- Root Directory: `apps/api`
- Runtime: Node
- Build Command: `npm ci --include=dev --legacy-peer-deps && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`

The generated backend entrypoint is `dist/index.js`; never select
`src/index.ts` in production. The Dockerfile remains available for a deliberate
container deployment but is not used by this Blueprint.

Frontend Web Service (the current deployment type):

- Root Directory: `apps/web`
- Build Command: `npm ci --include=dev --legacy-peer-deps && npm run build`
- Start Command: `npm start`
- Start file: `scripts/serve-production.mjs`
- Health Check Path: `/health`

The production server serves immutable hashed assets and rewrites unknown HTML
routes to `dist/index.html`, so refreshing a client-side route remains valid.

## Domains and DNS

The Blueprint assigns:

- `kletiaai.xyz` to the frontend Web Service. Add `www.kletiaai.xyz` as a
  redirect/alias in Render if it is not created automatically.
- `api.kletiaai.xyz` to the backend.

After Blueprint creation, copy the exact DNS targets displayed in each Render
service's **Settings -> Custom Domains** page to the domain provider. Verify
both domains in Render before public testing. Remove conflicting `AAAA` records
unless Render explicitly instructs otherwise. Keep the Render subdomains
enabled during the first rollout; disable them only after both custom domains,
TLS, wallet connections, x402 relay, Base, and Arc checks pass.

## Required production environment values

Values marked `sync: false` in `render.yaml` must be entered in the Render
Dashboard. An existing Blueprint does not prompt again for newly-added
`sync: false` values, so add missing values manually.

Render exposes `NODE_ENV=production` during the build. Do not shorten either
build command to `npm install` or a plain `npm ci`: TypeScript, Vite, and the
Node/Express declaration packages are build-time devDependencies and must be
installed with `--include=dev`. They are not imported by the emitted API
runtime.

Backend minimum for a healthy public release:

- `BASE_RPC_URL`: dedicated Base Mainnet HTTPS RPC. Do not use a testnet URL.
- `OPENROUTER_API_KEY`: intent parsing.
- `WEBACY_API_KEY`: URL and transaction-risk gates.
- `ALLORA_API_KEY`: live prediction routes.
- `ALCHEMY_API_KEY`: portfolio and token metadata paths.
- `X402_TREASURY_ADDRESS`: public Base treasury address, not a private key.
- Coinbase/CDP and Across values only for the corresponding enabled routes.

Do not upload `PRIVATE_KEY`, `BASE_PRIVATE_KEY`, `ARC_PRIVATE_KEY`, or a
deployer key to either Render service. The public application builds plans and
requests the connected user's wallet signature; deployment/funding scripts are
separate operator workflows and their signers do not belong in the web runtime.

Frontend build-time values:

- `VITE_BACKEND_URL=https://api.kletiaai.xyz`
- `VITE_BASE_RPC_URL`: a browser-safe Base Mainnet RPC URL. Every `VITE_*`
  value is public in the JavaScript bundle; apply provider domain/rate limits
  and never put a private server credential here.
- `VITE_ARC_RPC_URL=https://rpc.testnet.arc.network`
- `VITE_WALLETCONNECT_PROJECT_ID`: restrict it to `kletiaai.xyz` and
  `www.kletiaai.xyz` in the provider dashboard.
- `VITE_BASE_SWAP_EXECUTION_MODE` must match backend
  `BASE_SWAP_EXECUTION_MODE`. Both remain `legacy_v1` until an intentional,
  evidence-backed V2 cutover.

Never copy `.env` files or private keys to a static-site `VITE_*` variable.
Render secrets belong only in the backend service's Environment page.

## Release checks

Before opening the site publicly:

1. Backend `/health` returns 200 without RPC work.
2. Backend `/api/health/base` reports chain `8453` and status `ready`.
3. Backend `/api/health/arc` reports chain `5042002` and status `ready`.
4. `https://kletiaai.xyz` loads with no localhost requests in DevTools.
5. Switching Base -> Arc changes wallet network and clears stale executable
   intents; switching Arc -> Base does the same.
6. Test one read-only intent per network before any value-bearing intent.
7. For x402, verify the live `402` challenge and wallet approval screen. Do not
   call a paid endpoint without its real `PAYMENT-RESPONSE` and Base receipt.
8. Confirm frontend requests receive CORS permission only from the production
   domains and that no private key or server API secret appears in the bundle.

DNS/TLS changes can take time to propagate. Do not change the frontend backend
URL to the custom API domain until Render shows `api.kletiaai.xyz` as verified;
the committed Blueprint already expects that final production hostname.
When using Cloudflare, keep the DNS records in DNS-only mode for the first
release so Render sees the expected single proxy hop; add another proxy layer
only with an explicit `TRUST_PROXY_HOPS` review and rate-limit spoof test.
