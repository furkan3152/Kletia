# Repository Structure

Kletia is one product with three isolated network profiles and a staged
cross-chain workflow layer. The directory layout follows runtime ownership,
not implementation history.

```text
apps/
  api/
    src/index.ts                 HTTP composition root
    src/networks/base/           Base-only discovery and execution
    src/networks/arc/            Arc-only programmable-money runtime
    src/networks/arbitrum/       Arbitrum-only Uniswap/Aave runtime
    src/shared/                  Common parser, registry, policy and safety
    src/cross-chain/             Base-Arbitrum workflow graph and checkpoints
    src/integrations/            Bounded external-provider routes
    src/scripts/                 Operator-only commands, excluded from build
  web/
    src/main.tsx                 Browser entry point
    src/app/                     Application shell and global styles
    src/networks/*/              Network-owned UI and execution bindings
    src/shared/                  Common UI, state, hooks, types and validation
    src/cross-chain/             Workflow presentation
    src/integrations/            External-provider interfaces
contracts/
  base/                          Base Mainnet Solidity and evidence tooling
  arc/                           Arc Testnet Solidity and migration tooling
attachments/                     Path-stable hackathon submission material
docs/                            Architecture, deployment and protocol records
tooling/                         Repository-wide structural validation
render.yaml                      API and static-site deployment definition
```

## Ownership rules

- A network-owned module may import `shared`, but Base-owned code must not
  import Arc-owned code and Arc-owned code must not import Base-owned code.
- `shared` contains reusable parsing, policy, validation and presentation
  primitives. It is not a generic home for protocol calldata or contract
  targets.
- `cross-chain` may coordinate Base and Arbitrum only through sealed,
  network-bound steps. Arc Testnet never enters a mainnet capital workflow.
- `integrations` owns external HTTP-provider boundaries. Protocol contracts and
  chain-specific transaction builders remain in `networks/<network>`.
- `contracts/base` never compiles or deploys Arc sources. `contracts/arc` never
  contains Base x402 or Base router sources.
- Source identifiers, package names, comments and documentation use English.
  Turkish intent synonyms are accepted only in explicitly allowlisted parser
  sources.
- Generated output, caches, local exports, private keys and wallet files are
  not source and are never tracked.
- Files under `attachments/` have immutable paths and validated hashes because
  prior submissions reference them. Refactors must not move or modify them.

Run `npm run check:structure` after any package, source-boundary or deployment
path change. The check rejects deprecated paths, cross-network imports,
generated files, attachment changes, mixed contract ownership and stale Render
roots.
