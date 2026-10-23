# Kletia handoff

For the owner: what exists after round 6, how to run it, what only you can do,
and what is known to be missing. Branch `ccr-cc3fa951-22gm0c`, 2026-10-15 (round 7).

## What exists

**Networks (9).** Production: Base, Arbitrum One, Ethereum, OP Mainnet,
Polygon PoS and Solana. Testnet: Arc Testnet, Arbitrum Sepolia and Solana
Devnet. Production and testnet money never share one intent.

**Protocols.** `GET /v1/protocols` lists 51 protocols, 38 of them executable
through the API, plus two own-contract slots (EVM contract calls and Solana
Actions). The others are naming (ENS, Basenames, SNS), data (Chainlink,
Pyth, Allora, Webacy), payments (x402) or console-only suites. The site computes these numbers from
the same registry (`apps/web/src/app/site/protocolCount.ts`), so they cannot
drift from the code.

**Round 8 added:** the admin panel at `/admin` (see "Operator tasks" for what
it needs), and fixes from the live site (the site build had been failing since
round 6; it now deploys the current desk).

**Round 7 added:**

- **Intent engine v2.** Sentences become typed goals; a solver searches every
  network, venue and holding for routes and ranks them. It asks only when the
  answer changes the result (amount above balance, which network, stake or
  lend, which asset pays, a misspelt token) and shows every other choice as a
  chip. Eval: 338 prompts, 95.9% correct, 0 wrong plans, enforced in tests.
- **Ten more executable protocols.** PancakeSwap V3, Camelot, Curve, Stader,
  Mantle LSP, Frax Ether, Jito and Sanctum stake pools, Marinade and native SOL
  staking; CCTP V2 on the test networks; USDT allowance resets.
- **Coverage gate.** `npm run verify:coverage -w @kletia/api -- --api <url>`
  plans 68 network and protocol cells as dry runs.

**Round 6 added:**

- **The desk at `/app`.** One text box for all nine networks, a departure board
  (Auto plus each network) that sets `sourceNetwork`, tasks with ticket and
  fare, holdings, activity, and every network's extra tools inline. The old
  per-network console is deleted.
- **The journey.** `GET /v1/intents/{id}/journey` (or `?journey=true`) says,
  for every step, where the money is, who holds it, the least that arrives,
  refunds and gas on arrival. `POST /v1/intents/{id}/stop` ends an intent
  between steps. The desk, Studio, the widget and the link page draw it.
- **Questions.** `POST /v1/intents?clarify=true` asks one or two short
  questions instead of refusing an incomplete sentence. Threads are held by the
  client, or by Kletia for API keys (`/v1/threads`). The engine is
  deterministic: no model in the path.
- **New venues.** Uniswap V3 on five EVM networks, Aerodrome and Velodrome
  Slipstream, SparkLend, Spark Savings, Fluid, Yearn V3, Lido, Rocket Pool,
  ether.fi, Raydium, Orca and Meteora (through Jupiter), and Across and Circle
  CCTP V2 in the bridge auction.
- **Projects and publishable keys.** Brand, allowed origins, domain proof
  (`/.well-known/kletia.json`), defaults, stored flows and a logo. A `kl_pub_`
  key is safe in a browser: it reaches only the routes a page needs, from the
  allowed origins.
- **Embed delivery and the Embed Builder.** The embed script is served from
  the Kletia origin with Subresource Integrity. The builder at
  `/developers/embed` writes a snippet that only ever carries `kl_pub_` keys.
  Appearance tokens theme the widget and the embed.
- **Portal.** A page per tool under `/developers` (Keys, Project, Embed, API,
  Events, Errors, Venues, Agents, Recipes, Contracts, Rule Book, Links,
  Receipts, Webhooks). Also: sandbox keys, the event stream
  (`GET /v1/events`), the served OpenAPI document and `/changelog`.

Earlier rounds are still in place: the Platform API v1, the SDK, the widget,
the embed and the CLI; MCP at `/v1/mcp`; bring your own contract; fare
breakdown; signed receipts; the Rule Book; and intent links. See `CHANGELOG.md`
for the full list and `docs/README.md` for the guides.

## How to run it

```bash
npm ci                                   # installs and builds the @kletia/* packages
service postgresql start                 # optional; without a database the API uses memory
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
npm run dev:api                          # http://localhost:3001  (/api and /v1)
npm run dev:web                          # http://localhost:5174
```

To check everything:

```bash
KLETIA_TEST_DATABASE_URL=postgres://kletia:kletia@127.0.0.1:5432/<db> npm run verify
npm run check:openapi                    # OpenAPI and collection drift; npm run generate:openapi refreshes them
VITE_BACKEND_URL=https://api.kletiaai.xyz npm run build:web
```

Docker Compose (PostgreSQL, API and site) and the GHCR images are described in
`docs/deployment/self-hosting.md`.

## Operator tasks (only you can do these)

1. **Database.** The admin panel and durable keys need PostgreSQL. Render's
   free plan allows one free database per workspace and `muavin-db` already
   uses it, so take a paid Render PostgreSQL (Frankfurt, same region as the
   API) or a free external one (Neon, Supabase; use its pooled `postgres://`
   URL with `sslmode=require`). On the API service, set:
   - `KLETIA_DATABASE_URL`: its internal connection string.
   - `KLETIA_PLATFORM_SECRET`: 32 or more random characters, for example
     `openssl rand -hex 32`.
   - `WORKFLOW_SIGNING_SECRET`: 32 or more random characters.
   - `NODE_ENV=production` and `KLETIA_WEB_ORIGIN=https://kletiaai.xyz`.

   Without a database, keys, intents, projects and webhooks live in memory and
   are lost when a free instance sleeps.
2. **Receipt signing key.** Generate an Ed25519 seed yourself and never put it
   in git. On the API, set:
   - `KLETIA_RECEIPT_SIGNING_KEY`: the base64url 32-byte seed. It must not equal
     or derive from the platform secret.
   - `KLETIA_RECEIPT_KEY_NOT_BEFORE`: the first UTC day the key may sign.

   On the static site, set `KLETIA_RECEIPT_PUBLIC_KEY` (`{"x":"…","notBefore":"…"}`)
   so the build writes the `/.well-known/kletia-receipt-keys.json` mirror. Keep
   `KLETIA_RECEIPT_KEYSET` and `KLETIA_RECEIPT_NEXT_KEY` for rotation. Steps:
   `docs/platform/receipts.md` and `docs/deployment/render.md`.
3. **Dashboard rewrites and headers** (the dashboard-created services do not
   read `render.yaml`):
   - Static site, Redirects/Rewrites, in this order, all as Rewrite:
     1. `/go/:id/card.png` to `https://api.kletiaai.xyz/v1/links/:id/card.png`
     2. `/go/:id` to `https://api.kletiaai.xyz/v1/links/:id/page`
     3. `/*` to `/index.html`
   - Static site, Headers: copy the `headers` of `kletia-frontend` from
     `render.yaml` (framing, `X-Robots-Tag`, CORS for `actions.json` and the
     receipt key mirror). Include the `/sdk/embed/*/*.js`,
     `/sdk/embed/manifest.json`, `/sdk/kletia-sdk-*.js` and `/sdk/manifest.json`
     rules (`Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy:
     cross-origin`): without them browsers block the embed snippet and the SDK
     file on every other site, and the `Public smoke` workflow fails.
   - Do not apply `render.yaml` as a Blueprint to this account: the live
     services were created in the dashboard under other names, so a Blueprint
     would create a second API and site.
4. **npm packages.** Create the `@kletia` npm org and add an automation token
   as the `NPM_TOKEN` repository secret (environment `npm`). Then run
   `npm run bump:packages -- 0.2.0`, commit the bump, and push the tag
   `packages-v0.2.0` (not `v0.2.0`). `.github/workflows/release-packages.yml`
   checks the tag against the versions, attaches the `npm pack` tarballs to the
   GitHub release and publishes all five packages with provenance. They are at
   `0.1.0` and not on npm yet, so the docs pin `0.1.0`. Before npm, run the
   workflow by hand (Actions, Release packages, Run workflow) to publish the
   `packages-v0.1.0` release with its tarballs only; the site also serves the
   SDK as one file at `/sdk/kletia-sdk-0.1.0.js` (`docs/platform/quickstart.md`,
   "Install without npm").
5. **Optional provider keys.** Everything read-only works without them:
   - `RELAY_API_KEY`: higher Relay limits.
   - `JUPITER_API_KEY`: the paid Jupiter tier.
   - `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID` and `ACROSS_MAX_RELAY_FEE_BPS`:
     integrator attribution and the fee cap for Across. The v1 bridge auction
     already quotes Across without them.
   - `LIFI_API_KEY` and `DEBRIDGE_ACCESS_TOKEN`.
   - Private RPC URLs (`ETHEREUM_RPC_URL`, `BASE_RPC_URL`, …).
   - `X402_TREASURY_ADDRESS`: who receives x402 payments. It takes precedence
     over `KLETIA_FEE_RECIPIENT`; with neither set the paid routes answer 503.
     Set it to the treasury Safe to send x402 income there.

   The hosted API does not set `KLETIA_REQUIRE_ALL_FEATURES`, and neither does
   `render.yaml`: keep it that way. With it set, the API refuses to start while
   any of these keys (Webacy and Allora included) is missing; without it, those
   features are reported as needing configuration.

## Known limits

- The live intent eval now depends on wallet
  balances; use a funded read-only preview wallet or compare by class.

- Nothing here has had an external security audit. Nothing in the project
  signs or sends transactions, and it should stay that way.
- The round-6 security review read the Solana DEX layouts, the vault families
  and the LST adapters only briefly; they did not get a full adversarial pass.
  Its one reproduced finding is fixed with a regression test (see below).
- Domain verification is re-checked about once a day. A website that stops
  listing the project keeps its badge until the next check.
- The network guides in `docs/networks/` describe the round-3 venues. The
  round-6 venues are covered by `GET /v1/protocols`, the README and the
  CHANGELOG, but not yet by per-network pages. The EVM lending additions have
  evidence (`docs/networks/evidence/evm-lending-additions.json`) but no guide page yet.
- Fill attribution is a documented trust assumption. Jupiter prices can be
  stale for thin tokens (`POLICY_PRICE_UNAVAILABLE`, fail closed). Solana v1
  transactions are refused in Solana Actions, the deBridge check and the SDK
  policy guard.
- The event stream replays from a per-process buffer (500 events, 10 minutes).
  With several API instances, a reconnect can land on another instance's
  buffer.
- The commit history contains `wip:` commits. Squash them if you prefer.

## Security fixes in this release

- A project's `brand.website` now accepts only the default https port. The
  domain record is keyed by host and port, so a proof served on another port
  (for example `:8443`) can never verify the host on 443. Regression tests:
  `packages/core/test/projects.test.mjs` and
  `apps/api/src/platform/http/__tests__/projects.test.ts` ("never lets a proof
  on a non-default port verify the host on 443").
