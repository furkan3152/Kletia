# Changelog

All notable changes are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version labels follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries describe implementation and evidence boundaries; they do not imply an audit or funded lifecycle unless stated explicitly.

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

### Changed

- npm workspace with one root lockfile for apps and packages; Render, Vercel, Docker and CI build from the repository root.
- Public identity-pinned deployments (Intent Router V2, LaunchFactory V2, Arc Vault V2) and Arbitrum One are enabled by default; operator values still win.
- The API starts in degraded mode when an RPC is unreachable (a chain mismatch remains fatal) and warns instead of refusing to start when optional integration keys are missing.
- Base pre-sign screening works without Webacy for action-bound targets (reviewed manifest + bytecode attestation).
- The API entry point is split into focused HTTP modules; `/v1` has its own CORS policy for browser integrators.
- Wallet SDKs load only on wallet routes; the web entry bundle drops from 1.24 MB to about 160 KB.
- Security updates for axios, fast-uri, toml, `@coinbase/cdp-sdk` and `@x402/*`.

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
