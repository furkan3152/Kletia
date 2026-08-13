# Kletia Contracts — Base Mainnet

Base-only Solidity workspace for Kletia routers, adapters, token launch, x402
and supporting legacy deployments.

- `contracts/v2`: current intent-router architecture and typed adapters
- `contracts/legacy`: source retained for existing Base deployments
- `contracts/x402`: Base x402 seller contracts
- `contracts/giwa`: GIWA-specific Base integration
- `deployments`: public deployment manifests and runtime identities
- `scripts/v2`: evidence exporters and release policy tooling

Legacy source is intentionally isolated and is not an alternate deployment
entrypoint. The package does not keep ambiguous one-off deployment scripts.

No Arc deployment source belongs in this package.
