# Repository Structure

Kletia is a single product with two isolated network profiles. The repository
layout reflects runtime responsibility rather than the network that happened
to be implemented first.

```text
apps/
  api/
    src/networks/base/  Base protocol adapters, intents, routes, and policies
    src/networks/arc/   Arc contract ABI, intents, routes, and App Kit support
    src/                Shared parser, security, middleware, and API envelope
  web/
    src/networks/base/  Base execution policies and x402 runtime
    src/networks/arc/   Arc configuration and Circle App Kit runtime
    src/components/     Shared and explicitly network-owned interface modules
contracts/
  base/             Base Mainnet Solidity, deployments, and evidence tools
  arc/              Arc Testnet Solidity and verification configuration
attachments/        Path-stable hackathon submission material
docs/               Architecture, registry, deployment, and grant documents
tooling/             Repository-wide structural validation
render.yaml          Two-service production deployment definition
```

## Ownership rules

- `apps/api/src/config/networks.ts` is the shared network registry and enforces
  chain identity, native-asset metadata, supported actions, and policy targets.
- Base and Arc transaction construction live under their respective
  `apps/api/src/networks/*` boundaries. They only share parser, security,
  middleware, and response-envelope infrastructure.
- User-facing Turkish copy and Turkish intent synonyms are product language
  data. Source identifiers, package names, internal comments, and repository
  documentation use English.
- `contracts/base` never compiles or deploys Arc sources.
- `contracts/arc` never contains Base x402, GIWA, or Base router sources.
- Build artifacts, caches, local data exports, private keys, and wallet files
  are not source and are never tracked.
- Files under `attachments/` have stable public paths because prior hackathon
  submissions reference them. Refactors must not move or rename them.

Run `npm run check:structure` from the repository root after any package or
deployment-path change.
