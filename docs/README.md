# Kletia documentation

This index separates current product truth from deployment procedure, network-specific implementation, and historical material. Start with the shortest document that answers your question; deployment manifests and runtime readiness are authoritative when prose and live identity differ.

## Read by goal

| Goal | Start here | Then read |
|---|---|---|
| Understand the product and trust model | [Architecture overview](architecture/overview.md) | [Repository structure](architecture/repository-structure.md) |
| Integrate Kletia into another product | [Platform API v1](platform/api-v1.md) | [Error catalog](platform/errors.md), [OpenAPI document](platform/openapi.json), [API collections](platform/collections/README.md), [Core spec](../packages/core/README.md), [SDK](../packages/sdk/README.md), [widget and hooks](../packages/widget/README.md), [CLI](../packages/cli/README.md) |
| Put the intent widget on any website | [Embed web component](platform/embed.md) | [@kletia/embed](../packages/embed/README.md), [widget and hooks](../packages/widget/README.md) for React apps |
| Connect an AI agent | [MCP server](platform/mcp.md) | [Platform API v1](platform/api-v1.md) |
| Bridge between networks | [Cross-chain venues](networks/cross-chain-venues.md) (Relay, LI.FI, deBridge DLN auction) | [Platform API v1](platform/api-v1.md) |
| Run or deploy Kletia | [Root README](../README.md) | [Render runbook](deployment/render.md), [Vercel constraints](deployment/vercel.md), [Self-hosting and container images](deployment/self-hosting.md) |
| Work on Base | [Base DeFi registry](networks/base-defi-registry.md) | [Base contracts](../contracts/base/README.md), [Base MCP notes](base-mcp/README.md) |
| Work on Arc | [Arc contracts](../contracts/arc/README.md) | [Vault V2 migration](../contracts/arc/VAULT_V2_MIGRATION.md) |
| Work on Arbitrum | [Arbitrum workflow](networks/arbitrum-workflow.md) | [Architecture overview](architecture/overview.md) |
| Work on Solana | [Solana network guide](networks/solana.md) | [Platform API v1](platform/api-v1.md) |
| Work on Ethereum, OP Mainnet or Polygon | [Ethereum](networks/ethereum.md), [OP Mainnet](networks/optimism.md), [Polygon](networks/polygon.md) | [Cross-chain venues](networks/cross-chain-venues.md) |
| Test a real-data release | [MVP live-test runbook](runbooks/mvp-live-test.md) | [Render runbook](deployment/render.md) |

## Canonical product documents

- [Architecture overview](architecture/overview.md) — components, lanes, custody, execution, evidence, and failure model.
- [Repository structure](architecture/repository-structure.md) — module ownership, path stability, and extension rules.
- [Platform API v1](platform/api-v1.md) — public integration contract (REST, events, webhooks, keys, idempotency, usage).
- [Error catalog](platform/errors.md) — every error and step-failure code, its status, retry rule and remedy (also `GET /v1/errors`).
- [Contracts](platform/contracts.md) — register your own EVM contracts and Solana Actions.
- [Asset preview](platform/preview.md) — the fare breakdown and `PREVIEW_CHANGED`.
- [Receipts](platform/receipts.md) — signed, selectively disclosed, independently verifiable receipts.
- [Policies](platform/policies.md) — the Rule Book, agent keys and approvals.
- [Intent links](platform/links.md) — shareable, bounded intents at `/go/<id>`.
- [MCP server](platform/mcp.md) — read-only Model Context Protocol tools at `/v1/mcp` for AI agents.
- [Embed web component](platform/embed.md) — `<kletia-intent>` and `mountKletiaIntent()` for any site, the frame bridge protocol and server-side verification.
- [OpenAPI document](platform/openapi.json) and [API collections](platform/collections/README.md) — the machine-readable contract (generated from the API source, drift-checked by `npm run check:openapi`) and a Postman v2.1 collection for Postman, Insomnia, Bruno and Hoppscotch.
- Packages: [@kletia/core](../packages/core/README.md), [@kletia/sdk](../packages/sdk/README.md) (with `@kletia/sdk/server` webhook helpers), [@kletia/widget](../packages/widget/README.md) (with `@kletia/widget/hooks`), the [@kletia/embed](../packages/embed/README.md) web component and the [@kletia/cli](../packages/cli/README.md) command line. All five are versioned in lockstep and published by `.github/workflows/release-packages.yml`.
- [Root README](../README.md) — project overview, setup, verification, and current release boundary.
- [API README](../apps/api/README.md) and [web README](../apps/web/README.md) — application development.
- [Security policy](../SECURITY.md), [contribution guide](../CONTRIBUTING.md), and [changelog](../CHANGELOG.md).

## Network references

- Base Mainnet: [Base DeFi registry](networks/base-defi-registry.md), [contract workspace](../contracts/base/README.md), [Base MCP integration](base-mcp/README.md), [plugin manifest notes](base-mcp/kletia-base-plugin.md)
- Arbitrum: [production and Testnet workflow](networks/arbitrum-workflow.md)
- Arc Testnet: [contract workspace](../contracts/arc/README.md), [Vault V2 migration](../contracts/arc/VAULT_V2_MIGRATION.md)
- Solana: [network guide](networks/solana.md)
- Ethereum: [network guide](networks/ethereum.md)
- OP Mainnet: [network guide](networks/optimism.md)
- Polygon PoS: [network guide](networks/polygon.md)
- Between networks: [cross-chain venues](networks/cross-chain-venues.md) — Relay, LI.FI and deBridge DLN, pinned contracts and the bridge auction

## Deployment and operations

- [Render Blueprint runbook](deployment/render.md) — canonical public deployment topology.
- [Vercel deployment constraints](deployment/vercel.md) — supported frontend/API alternative and state limitations.
- [Self-hosting](deployment/self-hosting.md) — Docker Compose, the GHCR images (provenance and SBOM) and a public deployment checklist.
- [Real-data MVP test](runbooks/mvp-live-test.md) — evidence ladder and user-signed smoke procedure.

## Historical material

- [Competitive landscape](architecture/competitive-landscape.html)

Files under [`attachments/`](../attachments/GASOK_Team_Archial.md) are path- and hash-stable submission artifacts. Do not edit or relocate them to update current documentation.

## Source-of-truth order

When two records differ, use this order:

1. live chain/RPC/provider evidence for the exact operation;
2. current deployment manifest;
3. runtime readiness and capability code;
4. current architecture and runbooks;
5. proposals, research reports, and submission attachments.

No single level proves all others: a codehash proves identity, a test proves its checked behavior, and a transaction proves only that exact transaction.
