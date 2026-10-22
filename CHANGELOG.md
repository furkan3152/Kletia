# Changelog

All notable changes are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version labels follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries describe implementation and evidence boundaries; they do not imply an audit or funded lifecycle unless stated explicitly.

## [Unreleased]

Round 8: a wallet-gated admin panel for the owner, and fixes found on the
live site. Nothing here signs or holds funds; the admin wallet signs every
on-chain action in the browser.

### Added

- Admin panel at `/admin` (noindex, its own lazy chunk): sign in with the owner's EVM wallet (EIP-4361, EOA or ERC-1271) or Solana wallet (ed25519); allowlists `KLETIA_ADMIN_ADDRESSES` and `KLETIA_ADMIN_SOLANA_ADDRESSES`; off when unset, invalid or without a database in production ([admin](docs/deployment/admin.md)).
- Deployment registry for every Kletia contract on every EVM network it applies to: deploys built from committed artifacts (`npm run export:contract-artifacts`, checked in `verify`), signed by the admin wallet, verified on-chain by the API (code, arguments, owner), exported as JSON for pinning. Solana has no Kletia programs.
- Owner management (direct or as Safe proposals with chain-derived hashes), fee and revenue view with x402 gateway claims, Render status and redeploy (server-side `RENDER_API_KEY`), env readiness (booleans only) and a persistent audit log.
- Every admin write (deploy records, reverify, Safe proposals, fee rescans, redeploys, settings) needs a fresh wallet confirmation signed by the session's own wallet (single-use, 5 minutes): a stolen session cookie can only read. "Verified" deployments must be admin-controlled; others are "foreign", never exported or used as dependencies.
- Intent engine: whole-balance readings for stake, deposit and withdraw ("stake my SOL", "withdraw my USDC from aave"), the single position when a venue and network are named, leading labels ("rent: send 500 USDC to …") kept as notes, and "fund my <network> wallet" goals. Eval: 97.9% correct on the original 338 prompts (was 95.9%), 0 wrong plans.

### Fixed

- The hosted site build failed from round 6 onwards (the web workspace did not depend on `@kletia/embed`), so an old site stayed live; the desk now runs the round-7 engine.
- A lending venue over 99% borrowed or at its cap no longer wins the rate pick.
- Desk stamps: a task waiting on a question has no stamp, a refused task reads "Not planned"; redacted amounts in reloaded titles show as •••.
- Text fields focus with the ink border and a deeper offset shadow instead of a blue ring; network counts come from the registry everywhere; the status board marks a network delayed above 3 s.
- `/admin` has its own shell page on static hosts without rewrites.

## Round 7

Round 7: an intent engine that solves goals from what you hold, and ten more
executable protocols. The registry now lists 49 protocols, 38 of them
executable through the API. Nothing here signs or holds funds, and none of it
has had an external audit.

### Added

- Intent engine v2, on by default: a sentence is read into a typed goal (lexer, frames, amounts), and a solver searches a capability graph of every network, venue and holding for routes to it, ranked by fees, time, risk and yield. Goal sentences ("put my USDC to work", "get me 0.01 ETH on arbitrum", "consolidate to base", "exit my aave position") are solved from real holdings, positions, prices and rates, and kept as goals in the thread.
- A decision table asks only when the choice changes the result: `AMOUNT_EXCEEDS_BALANCE`, `ASSET_TYPO`, `EARN_KIND`, `SCOPE_AMBIGUOUS`, `INTERPRETATION_CONFIRM`. Everything else is chosen and shown as a chip (source, venue and rate, bridge, priced and back-solved amounts). A missing price is always asked, never guessed.
- A deposit with no venue picks the best rate for its risk; "stake ETH on base" offers buying an LST there or bridging and staking with Lido. "Borrow" and "repay" get a clear "not available yet".
- Venues: PancakeSwap V3 (Ethereum, Base, Arbitrum) and Camelot (Algebra, Arbitrum), Uniswap V3 on Arbitrum Sepolia with a testnet price guard, Curve 3pool on Ethereum, Stader, Mantle LSP and Frax Ether on Ethereum, SPL stake pools (Jito, Sanctum), Marinade and native SOL staking (also on Solana Devnet), and Circle CCTP V2 on the test networks. Solana liquid staking auctions the stake pool against the Jupiter route.
- Ethereum USDT approvals reset the allowance to zero first (`APPROVAL_RESET_REQUIRED` where a single transaction is needed).
- `PREVIEW_TESTNET` preview tag; clarify supports testnet swaps, CCTP testnet bridges and devnet staking.
- Gates: the intent eval (338 prompts, 95.9% correct, 0 wrong plans) is enforced in the test suite; a protocol coverage matrix (68 cells) runs offline and live (`npm run verify:coverage -w @kletia/api`). Site and README protocol counts come from the registry and a test fails on drift.

### Fixed

- Clarify no longer replaces a named staking provider (Stader, Mantle, Frax, native) with Lido.
- Native SOL staking sent the rent account size as a string on a running API.

## Round 6

Round 6: one desk for nine networks, a journey that says where the money is
after every step, clarifying questions instead of refusals, new
venues, and a project setup that lets a static site run Kletia with a
browser-safe key. The registry now lists 42 protocols, 28 of them executable
through the API, plus your own contracts. Nothing here signs or holds funds,
and none of it has had an external audit.

### Added

- Departure: `sourceNetwork` (a network key or `"auto"`) names where the funds start; the planner puts a bridge in front of the first action when needed and explains its choice in `intent.interpretation.departure` (`SOURCE_REQUIRED`, `SOURCE_UNREACHABLE`) ([API](docs/platform/api-v1.md)).
- The desk at `/app`: one text box for all nine networks, a departure board (Auto plus every network, test networks collapsed), tasks with ticket and fare, holdings, activity, a signing lock, and every network's extra tools inline. The old per-network console is gone; Studio hands off with "Run in the console".
- Journey ledger (`kletia.journey/v1`, `GET /v1/intents/{id}/journey`, `?journey=true`): for every step, where the money is, who holds it, the least that arrives, refunds, gas on arrival and what follows. `POST /v1/intents/{id}/stop` ends an intent between steps (`409 INTENT_IN_FLIGHT` while a step is in flight). Amounts flow between legs, with opt-in `constraints.gasOnArrival` through Relay top-ups ([journey](docs/platform/journey.md)).
- Clarifying questions: `POST /v1/intents?clarify=true` asks one or two short questions with options from the person's balances instead of refusing an incomplete sentence; defaults show as chips. Client-held threads, or Kletia-held threads for API keys (`/v1/threads`); the MCP `plan_intent` tool clarifies by default. The engine is deterministic (no model) ([clarify](docs/platform/clarify.md)).
- Venues: Uniswap V3 on Base, Arbitrum, Ethereum, OP Mainnet and Polygon; Aerodrome (Base) and Velodrome (OP Mainnet) Slipstream; SparkLend, Spark Savings, Fluid Lending and Yearn V3; Lido, Rocket Pool and ether.fi; Raydium, Orca and Meteora as named routes through the Jupiter program; Across and Circle CCTP V2 (EVM to EVM and EVM to Solana) in the bridge auction. Each has pinned contracts, exact calldata checks and output proofs. Chainlink price bands, L2 sequencer gating and Pyth as a Solana price source.
- Projects (`kletia.project/v1`): brand, allowed origins, domain verification through `/.well-known/kletia.json`, defaults, stored flows and a logo, with `If-Match` concurrency (`/v1/projects/current`). Publishable keys (`kl_pub_…`) are safe in browser code: they reach only the routes a page needs, from the allowed origins, and run stored flows; a server key sent from a browser is refused with `SECRET_KEY_FROM_BROWSER` ([projects](docs/platform/projects.md)).
- Embed delivery: the embed script is served from the Kletia origin with Subresource Integrity, takes a publishable key and a flow, and shows the verified brand and questions. The Embed Builder in the portal writes the snippet and only ever outputs `kl_pub_` keys. Appearance tokens (`kletia.appearance/v1`) theme the widget and the embed with contrast floors ([theming](docs/platform/theming.md)).
- Developer portal: a page per tool (Keys, Project, Embed, API explorer, Events, Errors, Venues, Agents, Recipes, Contracts, Rule Book, Links, Receipts, Webhooks) with a URL per object; sandbox keys on the testnet lane; the key's event stream (`GET /v1/events`, `kletia listen`); the served OpenAPI document at `GET /v1/openapi.json`; [quickstart](docs/platform/quickstart.md), [status and versioning](docs/platform/status.md) and [client generation](docs/platform/codegen.md) guides; `/changelog` renders this file.
- SDK and CLI cover every round-6 surface: journey, stop, portfolios with positions, clarify turns and threads, error details, the event stream, sandbox keys, projects and publishable keys.

### Security

- A project's `brand.website` takes the default https port only, and the domain record is keyed by host and port: a proof served on another port of the same host can no longer verify the host on port 443 and carry the "verified" badge to `/embed`, flow sessions and the logo.
- Publishable keys are held to an allowlist of routes and to the project's origins; flows run with the contract authority of the key that saved them, re-checked at prepare.
- Messages that look like secrets (seed phrases, private keys) are refused before planning (`MESSAGE_SECRET_REFUSED`); mixed-case EVM recipients must pass their checksum (`RECIPIENT_CHECKSUM_INVALID`).
- Every catalogued error code is now emitted somewhere; the temporary allowance for codes that nothing emitted yet is gone.

### Fixed

- Hosted deploys: an install inside one app's folder (how the dashboard-created Render services build) no longer fails on packages that app does not use; the root `postinstall` skips a package whose build tools are not installed. The API had not deployed since the workspace move.
- The site build writes an HTML entry with its own title and description for every fixed route, so `/developers`, `/studio`, `/app` and the other pages load on hosts without a rewrite rule; `404.html` carries the same shell. The production server serves these entries too.
- `GET /health` names the service `kletia-api`.

Round 4 and 5: bring your own contract, and the features that make Kletia
more than a router. Nothing here signs or holds funds, and none of it has had an
external audit.

### Added

- Bring your own contract: register an EVM contract (ABI bindings, forbidden selectors, code-hash and proxy-implementation pins) or a Solana Action. Every call is simulated before it is handed out, verified from events, and shown with the fixed "Not audited by Kletia" notice and an acknowledgement gate ([guide](docs/platform/contracts.md)).
- Asset preview ("fare breakdown"): per-network, per-account asset changes with honest labels (simulated, assumed funds, venue minimum, quoted, estimated), fees in USD and gas-on-arrival warnings. Prepare refuses a payload that is worse than the preview the user approved (`PREVIEW_CHANGED`) ([guide](docs/platform/preview.md)).
- Verifiable receipts: Ed25519 signatures over RFC 8785 canonical JSON, selective disclosure with owner-held keys, a transparency log, public keys at `/v1/receipts/keys` and `/.well-known/kletia-receipt-keys.json`, an optional EAS envelope, and a `/r/<id>` page that verifies in the browser ([guide](docs/platform/receipts.md)).
- Rule Book policies: project, key and agent-key (`kl_agt_`) rules with Chainlink/Jupiter USD pricing that fails closed, atomic spend reservation, approvals by EIP-712 or Solana message signature (`/approve`), a hash-chained decision log, and "tighten now, loosen later" amendments ([guide](docs/platform/policies.md)).
- Intent links (`lk_...`, `/go/<id>`): publisher-defined bounds, per-visitor funding, share cards, Solana Actions and Blinks, and an activation delay for links that pay a fixed third party ([guide](docs/platform/links.md)).
- SDK, CLI, MCP, widget and embed support for all of the above, including integrator-created intents and sessions in the embed frame.
- Developer portal panels for contracts, Rule Book, links and receipts; the Interchange art system (route maps, tickets, stamps, departure boards) across the site.

### Security

- Dropping `confirm.approvers.keys` (which lets every project key approve) is a loosening and waits out the amendment delay.
- Pausing and resuming a pending link keeps its remaining activation delay; a rotated-out key secret cannot create or change links.
- Withdrawing receipt disclosures during an issuance is no longer undone, and the public EAS envelope carries only the day the payload already makes public.
- The receipt page rebuilds the link in its copied CLI command from checked parts, never from the address bar.

### Changed

- The console badge reads Kletia instead of OMNI; the site counts 29 protocols plus your own contracts everywhere.

Round 3: more networks and venues behind the same intent engine, and the
infrastructure surfaces integrators asked for. Every new address was read back
on-chain on 2026-10-09; nothing in this release signs or holds funds.

### Added

- Networks: Ethereum (`eip155:1`), OP Mainnet (`eip155:10`) and Polygon PoS (`eip155:137`) in the chain and asset registries, with chain-id-attested RPCs (`ETHEREUM_RPC_URL`, `OPTIMISM_RPC_URL`, `POLYGON_RPC_URL`, keyless public fallbacks) and per-network health.
- Bridge auction: Relay, LI.FI (Across, Polymer CCTP) and deBridge DLN quote every cross-network step in parallel; the winner has the highest guaranteed output net of priced extra costs, then the shortest time within `constraints.maxSeconds` (default 600 s), then the fewest transactions. Losing quotes are recorded as evidence and `POST /v1/quotes` ranks routes the same way (`eligible`, `netMinimumOutput`, `extraCosts`). "via lifi / debridge / relay" names one venue.
- Lending: `withdraw` (including "withdraw all") and registry venues (`YIELD_VENUES`, `params.venue`, `step.venue`) for Aave V3 (now also on Ethereum, OP Mainnet and Polygon), Compound V3, Morpho vaults (MetaMorpho and Vault V2, factory-proven), Moonwell, Jupiter Lend and Kamino, with on-chain APY notes and `GET /v1/venues` (supply APY, size and exit liquidity of the EVM lending venues; `kletia.venues()`, `kletia venues`).
- Recipient names: ENS (`*.eth`, through the pinned Universal Resolver; CCIP-Read refused), Basenames (`*.base.eth`) and SNS (`*.sns`), resolved again before every prepare (`409 RECIPIENT_NAME_CHANGED`).
- Platform API: error catalog (`GET /v1/errors`, `ERROR_CATALOG` in `@kletia/core`, a `docs` link on every error), key self-management (list, rotate with a grace window, revoke), `Idempotency-Key` on state-changing POSTs, webhook test deliveries and delivery logs, `GET /v1/usage`, a status badge, and a read-only MCP server at `/v1/mcp` with a Studio hand-off link.
- `@kletia/sdk`: retries with exponential backoff and automatic idempotency keys, typed error codes, `keys`, `webhooks.test/deliveries`, `usage()`, `errors()`, `intents.wait()` and `watchIntent`; `@kletia/sdk/server` webhook handlers for fetch-style runtimes, Hono, Express and `node:http`.
- `@kletia/widget/hooks`: `KletiaProvider`, `useKletiaIntent`, `useIntent`, `useQuote`, `useNetworks`, `usePortfolio`.
- `@kletia/cli` (`kletia`): health, registries, quote, plan (dry run unless `--save`), intents get/list/watch, keys, webhooks (including `verify` and `forward` to localhost), usage, errors and openapi. Published with the other packages.
- `@kletia/embed`: the `<kletia-intent>` web component and `mountKletiaIntent()` for any site, one dependency-free file for npm and for a CDN script tag with Subresource Integrity. It renders `/embed` in a sandboxed frame, follows the frame's content height (320–1600 px) and re-emits progress as composed DOM events (`kletia:ready`, `kletia:intent-planned`, `kletia:intent-created`, `kletia:step-updated`, `kletia:completed`, `kletia:error`, `kletia:resize`). `/embed` speaks the bridge only over a `MessageChannel` after one verified connect from its parent, tells the visitor the host is notified, and stores `ref` as `metadata.hostRef` ([embed guide](docs/platform/embed.md)).
- Machine-readable contract: `docs/platform/openapi.json` (exported from the API source by `npm run generate:openapi`, linted for references, operation ids, tags and path parameters) and a Postman v2.1 collection in `docs/platform/collections/` for Postman, Insomnia, Bruno and Hoppscotch. `npm run check:openapi` fails when either drifts from the source and runs in `npm run verify`.
- Container images: `.github/workflows/images.yml` pushes `ghcr.io/<owner>/kletia-api` and `kletia-web` on every push to `main` and every `v*` tag, with SLSA provenance (`mode=max`) and an SPDX SBOM, then checks the attestations and smoke-tests the pushed image. Actions are pinned to full commit SHAs.
- `npm run bump:packages -- <version>` moves all five packages, the apps' dependencies, the SDK and CLI version constants, the portal's embed version and the documented CDN URLs to one version and syncs the lockfile.

### Security

- Venue contracts, programs, vaults and markets come only from the pinned registry (`VENUE_CONTRACTS`, `YIELD_VENUES`); provider calldata is decoded and every target, spender, token, amount, recipient and fee is checked against it before a payload is returned. Venue state that disagrees with the registry is refused with `422 VENUE_UNVERIFIED`.
- Lending outcomes are proven from the venue's own events and token movements bound to the prepared payload (`SUPPLY_REPAID_DEBT`, `VENUE_REJECTED` and `OUTCOME_NOT_PROVEN` fail a step). Moonwell WETH markets must report their pinned WETH unwrapper.
- deBridge DLN's fixed fee must equal the on-chain value, an extra cost above the planned one fails prepare with `QUOTE_MOVED`, and an unfilled DLN order's cancel right goes to the user's own destination account whenever the intent names one.
- Rotated-out key secrets cannot manage keys (`403 KEY_SECRET_ROTATED`); stored idempotent responses that contain secrets are encrypted with `KLETIA_PLATFORM_SECRET`.

### Changed

- Relay uses its v3 status and request endpoints and is restricted to its pinned contracts per network.
- MCP and CLI treat the user's own address on another network of the same VM (a bridge's default recipient) as their own when listing external recipients.
- New configuration: `KLETIA_WEB_ORIGIN`, `KLETIA_MCP_ALLOWED_ORIGINS`, `LIFI_API_KEY`, `DEBRIDGE_ACCESS_TOKEN` and the three RPC variables (see `apps/api/.env.example`, `render.yaml` and `docker-compose.yml`); optional web wallet RPCs `VITE_ETHEREUM_RPC_URL`, `VITE_OPTIMISM_RPC_URL` and `VITE_POLYGON_RPC_URL` (Render, Compose and web image build arguments).
- Releases: `release-packages.yml` publishes core, sdk, widget, embed and cli in that order with npm 11 (ready for trusted publishing over OIDC, with `NPM_TOKEN` as the fallback), skips versions already on npm so a failed run can be re-run, and sends prereleases to the `next` dist-tag.
- `npm run check:packages` covers all five packages: every `exports`, `main`, `types`, `unpkg` and `bin` target must be in the tarball, conditional exports need `types` and `import`, `@kletia/sdk/server` and `@kletia/widget/hooks` must stay exported, the CLI binary needs its shebang, the embed loader must fit its gzip budget (4 KB script, 6.5 KB module), and the SDK and CLI version constants and the apps' `@kletia/*` dependencies must match the package version.
- `npm run verify` also runs the `/embed` bridge tests (`npm run test:web`) and the OpenAPI drift check.
- Docker: both Dockerfiles copy every workspace manifest before `npm ci`; the web image builds only the packages it imports; the API image sets `PORT=10000` (the port it exposes) and a `/health` `HEALTHCHECK`. Docker Compose can run the published images (`KLETIA_API_IMAGE`, `KLETIA_WEB_IMAGE`, `docker compose up --no-build`).

### Fixed

- Basenames resolution reads the resolver the Base registry names for each name, so names moved to the new resolver resolve again.
- The API image listened on 3001 while exposing 10000; it now listens on the exposed port unless `PORT` is set.

## [2.0.0] - 2026-10-08

Kletia becomes intent infrastructure for EVM networks and Solana: one engine
behind the app, a public API, an SDK and an embeddable widget.

### Added

- `@kletia/core`: chain-agnostic intent specification (CAIP-2/10/19 identities, chain, asset and protocol registries, intent graph, lifecycle rules, validation, event bus, webhook signatures).
- Platform API v1 (`/v1`): deterministic intent grammar and planner, adapters for Jupiter, Relay, Aave V3 and native/ERC-20/SPL transfers, on-chain and settlement verification, durable store, settlement poller, developer keys, rate-limit tiers, Server-Sent Events, signed webhooks with SSRF protection and an OpenAPI 3.1 document.
- `@kletia/sdk` (client, SSE, EIP-1193 and Wallet Standard signers, `executeIntent`) and `@kletia/widget` (embeddable React widget).
- Solana network: portfolio, Jupiter swaps, liquid staking, SOL/SPL/Token-2022 transfers, Relay settlement to and from Base and Arbitrum, Kamino rate discovery.
- Web: product home page, developer portal, network status page, Intent Studio with wallet execution, `/embed`, a chain-agnostic wallet layer (EVM and Solana connected together), a Solana console workspace and a cross-feature event bus with a shared activity feed.
- `GET /api/capabilities` reporting each feature as live, needs configuration or disabled.
- Resumable wallet execution in Studio, `/embed` and the Solana Ask tab: every prepared transaction is checked against its step (VM, network, chain, sender or fee payer) before a wallet sees it, an unknown wallet outcome pauses for confirmation instead of signing again, and broadcast references are resubmitted rather than re-signed.

### Security

- Solana transfers and Relay bridges refuse a token account, mint or program account as recipient; Token-2022 mints with transfer fees are refused.
- Re-prepares are compared with the planned price floor; earlier valid Jupiter payloads still verify after a re-prepare.
- Per-API-key webhook queues with in-flight and retry caps and paused failing endpoints; uncached key lookups are throttled per IP before the store is queried; streams opened with a key also count against the client IP.
- `clientReference` idempotency is enforced by a unique database index across instances.
- Only `/embed` may be framed by other sites; other pages also refuse to render inside a cross-origin frame.

### Changed

- npm workspace with one root lockfile for apps and packages; Render, Vercel, Docker and CI build from the repository root.
- Public identity-pinned deployments (Intent Router V2, LaunchFactory V2, Arc Vault V2) and Arbitrum One are enabled by default; operator values still win.
- The API starts in degraded mode when an RPC is unreachable (a chain mismatch remains fatal) and warns instead of refusing to start when optional integration keys are missing.
- Base pre-sign screening works without Webacy for action-bound targets (reviewed manifest + bytecode attestation).
- The API entry point is split into focused HTTP modules; `/v1` has its own CORS policy for browser integrators.
- Wallet SDKs load only on wallet routes; the web entry bundle drops from 1.24 MB to about 160 KB.
- Security updates for axios, fast-uri, toml, `@coinbase/cdp-sdk` and `@x402/*`.
- The settlement poller rotates fairly across active intents; steps whose provider reads keep failing move to manual review after their deadline.
- Self-hosted production starts without optional x402 configuration; the affected endpoints answer 503 and report `needs_configuration`.

### Removed

- The Stellar network (API, web, Soroban contracts, policy circuits, tooling and documentation).
- The Stellar-bound v2/v3/v4 workflow engines and their unreachable UI.
- Endpoints that could never succeed (`/api/agent`, two 501 premium routes) and dead code paths.

## [Unreleased before 2.0.0]

### Added

- Real Stellar Testnet passkey smoke manifest covering C-account creation, funding, and a `secp256r1` WebAuthn-authorized 0.1 XLM transfer under a virtual authenticator.
- Network-wide staged-intent tests for private amount placeholders and multi-action parsing.
- Separate core and labs local startup commands, including the opt-in Testnet reference solver.
- Documentation index, four-network architecture diagrams, repository ownership guidance, and automated Markdown path checks.

### Changed

- Stellar passkey accounts are the default Stellar account experience; Freighter remains available for compatible Classic flows.
- Core and labs claims are separated across README, architecture, deployment, and operator documentation.
- MPP PostgreSQL TLS mode handling now matches the other durable stores, including `verify-full` certificate verification.
- GitHub templates now request network, lane, wallet, evidence, recovery, and security context.

### Fixed

- Local labs startup and solver capability flags now use the same explicit profile.
- Private placeholder intents no longer depend on a concrete amount during the semantic planning stage.
- Stale repository-owner links, machine-specific setup paths, inaccurate package commands, and inconsistent license text.

## [1.0.0] - 2026-09-01

### Added

- Unified intent application for Base Mainnet, Arc Testnet, Arbitrum, and Stellar Testnet.
- Deterministic parsing, consented semantic fallback, network-bound entity resolution, route ranking, and staged recovery.
- Base Intent Router V2, typed swap adapter, Launch Factory V2, x402 contracts, and deployment evidence.
- Arc Testnet swap, lending, staking, Vault V2, memo, batch-payment, token, and forwarder contracts.
- Arbitrum One Uniswap V3/Aave adapters and Arc-to-Arbitrum Sepolia CCTP/Aave workflow.
- Stellar native payment/SDEX tools, passkey C-account integration, and capability-gated Payment Center.
- Policy V1/V2 circuits, Soroban control plane, route auction, private-payment, MPP, and workflow research labs.

### Security

- Exact network, wallet, asset, target, deadline, spender, calldata/XDR, nonce, and receipt bindings.
- Browser privacy egress controls, prompt-secret filtering, durable replay stores, and fail-closed provider readiness.
- Base production owner, guardian, and treasury roles separated across Safe accounts.

[Unreleased]: https://github.com/furkan3152/Kletia/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/furkan3152/Kletia/releases/tag/v1.0.0
