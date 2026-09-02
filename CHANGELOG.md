# Changelog

All notable changes are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version labels follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries describe implementation and evidence boundaries; they do not imply an audit or funded lifecycle unless stated explicitly.

## [Unreleased]

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
