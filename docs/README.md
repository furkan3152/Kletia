# Kletia documentation

This index separates current product truth from deployment procedure, network-specific implementation, and historical research. Start with the shortest document that answers your question; deployment manifests and runtime readiness are authoritative when prose and live identity differ.

## Read by goal

| Goal | Start here | Then read |
|---|---|---|
| Understand the product and trust model | [Architecture overview](architecture/overview.md) | [Repository structure](architecture/repository-structure.md), [live-test runbook](runbooks/mvp-live-test.md) |
| Run or deploy Kletia | [Root README](../README.md) | [Render runbook](deployment/render.md), [Vercel constraints](deployment/vercel.md) |
| Work on Base | [Base DeFi registry](networks/base-defi-registry.md) | [Base contracts](../contracts/base/README.md), [Base MCP notes](base-mcp/README.md) |
| Work on Arc | [Arc contracts](../contracts/arc/README.md) | [Vault V2 migration](../contracts/arc/VAULT_V2_MIGRATION.md) |
| Work on Arbitrum | [Arbitrum workflow](networks/arbitrum-workflow.md) | [Architecture overview](architecture/overview.md) |
| Work on Stellar native/passkey flows | [Stellar system guide](networks/stellar/system-guide.md) | [Soroban contracts](../contracts/stellar/README.md), [Payment Center architecture](networks/stellar/payment-center-architecture.md) |
| Test a real-data release | [MVP live-test runbook](runbooks/mvp-live-test.md) | [Render runbook](deployment/render.md) |
| Review research labs | [Stellar Payment Center master plan](networks/stellar/payment-center-master-plan.md) | [InstAward proposal](networks/stellar/instaward-proposal.md), [seedless research](research/stellar-seedless-2026-08-25/report-source.md) |

## Canonical product documents

- [Architecture overview](architecture/overview.md) — components, lanes, custody, execution, evidence, and failure model.
- [Repository structure](architecture/repository-structure.md) — module ownership, path stability, and extension rules.
- [Root README](../README.md) — project overview, setup, verification, and current release boundary.
- [API README](../apps/api/README.md) and [web README](../apps/web/README.md) — package-specific development.
- [Security policy](../SECURITY.md), [contribution guide](../CONTRIBUTING.md), and [changelog](../CHANGELOG.md).

## Network references

### Base Mainnet

- [Base DeFi registry](networks/base-defi-registry.md)
- [Base contract workspace](../contracts/base/README.md)
- [Base MCP integration](base-mcp/README.md) and [plugin manifest notes](base-mcp/kletia-base-plugin.md)

### Arc Testnet

- [Arc contract workspace](../contracts/arc/README.md)
- [Vault V2 migration](../contracts/arc/VAULT_V2_MIGRATION.md)

### Arbitrum

- [Arbitrum production and Testnet workflow](networks/arbitrum-workflow.md)

### Stellar Testnet

- [Stellar system guide](networks/stellar/system-guide.md)
- [Payment Center architecture](networks/stellar/payment-center-architecture.md)
- [Soroban contracts and deployment manifests](../contracts/stellar/README.md)
- [Policy circuit workspace](../circuits/stellar-policy/README.md)

## Deployment and operations

- [Render Blueprint runbook](deployment/render.md) — canonical public deployment topology.
- [Vercel deployment constraints](deployment/vercel.md) — supported frontend/API alternative and state limitations.
- [Real-data MVP test](runbooks/mvp-live-test.md) — evidence ladder and user-signed smoke procedure.

## Research and historical material

The following files explain explored designs or grant scope. They are not automatic claims about the default runtime:

- [Stellar Payment Center master plan](networks/stellar/payment-center-master-plan.md)
- [Stellar InstAward proposal](networks/stellar/instaward-proposal.md)
- [Stellar seedless research](research/stellar-seedless-2026-08-25/report-source.md)
- [Competitive landscape](architecture/competitive-landscape.html)
- [Privacy MVP validation artifact](networks/stellar/privacy-mvp-validation.html)

Files under [`attachments/`](../attachments/GASOK_Team_Archial.md) are path- and hash-stable submission artifacts. Do not edit or relocate them to update current documentation.

## Source-of-truth order

When two records differ, use this order:

1. live chain/RPC/provider evidence for the exact operation;
2. current deployment or protocol lock manifest;
3. runtime readiness and capability code;
4. current architecture and runbooks;
5. proposals, research reports, and submission attachments.

No single level proves all others: a codehash proves identity, a test proves its checked behavior, and a transaction proves only that exact transaction.
