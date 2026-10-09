# Changelog

All notable changes are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version labels follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries describe implementation and evidence boundaries; they do not imply an audit or funded lifecycle unless stated explicitly.

## [Unreleased]

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
