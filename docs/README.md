# Kletia documentation

This index separates current product truth from deployment procedure, network-specific implementation, and historical material. Start with the shortest document that answers your question; deployment manifests and runtime readiness are authoritative when prose and live identity differ.

## Read by goal

| Goal | Start here | Then read |
|---|---|---|
| Understand the product and trust model | [Architecture overview](architecture/overview.md) | [Repository structure](architecture/repository-structure.md) |
| Integrate Kletia into another product | [Platform API v1](platform/api-v1.md) | [Core spec](../packages/core/README.md), [SDK](../packages/sdk/README.md) |
| Run or deploy Kletia | [Root README](../README.md) | [Render runbook](deployment/render.md), [Vercel constraints](deployment/vercel.md), [Self-hosting](deployment/self-hosting.md) |
| Work on Base | [Base DeFi registry](networks/base-defi-registry.md) | [Base contracts](../contracts/base/README.md), [Base MCP notes](base-mcp/README.md) |
| Work on Arc | [Arc contracts](../contracts/arc/README.md) | [Vault V2 migration](../contracts/arc/VAULT_V2_MIGRATION.md) |
| Work on Arbitrum | [Arbitrum workflow](networks/arbitrum-workflow.md) | [Architecture overview](architecture/overview.md) |
| Work on Solana | [Solana network guide](networks/solana.md) | [Platform API v1](platform/api-v1.md) |
| Test a real-data release | [MVP live-test runbook](runbooks/mvp-live-test.md) | [Render runbook](deployment/render.md) |

## Canonical product documents

- [Architecture overview](architecture/overview.md) — components, lanes, custody, execution, evidence, and failure model.
- [Repository structure](architecture/repository-structure.md) — module ownership, path stability, and extension rules.
- [Platform API v1](platform/api-v1.md) — public integration contract (REST, events, webhooks).
- [Root README](../README.md) — project overview, setup, verification, and current release boundary.
- [API README](../apps/api/README.md) and [web README](../apps/web/README.md) — application development.
- [Security policy](../SECURITY.md), [contribution guide](../CONTRIBUTING.md), and [changelog](../CHANGELOG.md).

## Network references

- Base Mainnet: [Base DeFi registry](networks/base-defi-registry.md), [contract workspace](../contracts/base/README.md), [Base MCP integration](base-mcp/README.md), [plugin manifest notes](base-mcp/kletia-base-plugin.md)
- Arbitrum: [production and Testnet workflow](networks/arbitrum-workflow.md)
- Arc Testnet: [contract workspace](../contracts/arc/README.md), [Vault V2 migration](../contracts/arc/VAULT_V2_MIGRATION.md)
- Solana: [network guide](networks/solana.md)

## Deployment and operations

- [Render Blueprint runbook](deployment/render.md) — canonical public deployment topology.
- [Vercel deployment constraints](deployment/vercel.md) — supported frontend/API alternative and state limitations.
- [Self-hosting](deployment/self-hosting.md) — Docker images, Docker Compose and a public deployment checklist.
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
