# Contributing to Kletia

Kletia coordinates user-authorized finance across networks with different wallet, asset, contract, and finality models. Contributions must preserve those boundaries and distinguish source verification from live or funded evidence.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security vulnerabilities belong in the private process described in [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Use Node.js **22.23.1**, pinned by `.nvmrc`:

```bash
git clone https://github.com/furkan3152/Kletia.git
cd Kletia
nvm use

npm --prefix apps/api ci --include=dev --legacy-peer-deps
npm --prefix apps/web ci --include=dev --legacy-peer-deps
npm --prefix contracts/base ci --include=dev --legacy-peer-deps
npm --prefix contracts/arc ci --include=dev --legacy-peer-deps
```

There is no root npm workspace lockfile. Install the package whose lockfile you are changing. Labs that touch policy circuits also require:

```bash
npm --prefix circuits/stellar-policy ci --include=dev
```

Copy the environment templates only for local runtime work:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Never commit environment files, private keys, seed phrases, passkey material, recovery bundles, provider credentials, database dumps, or wallet exports. Browser `VITE_*` values are public.

## Choose the owning boundary

- Network-specific assets, contracts, calldata/XDR, receipts, and wallet behavior belong in `apps/*/src/networks/<network>`.
- Shared parsing, HTTP, disclosure, validation, and presentation primitives belong in `shared` only when they do not import protocol identity.
- Multichain coordination belongs in `cross-chain`, with typed steps and action-specific evidence.
- Base, Arc, and Stellar contract workspaces retain separate toolchains, manifests, and operator environments.
- Stellar policy, solver, private-payment, and MPP surfaces are labs unless the core release boundary is deliberately changed.

Read the [architecture](docs/architecture/overview.md) and [repository ownership rules](docs/architecture/repository-structure.md) before a cross-package change.

## Safety invariants

A contribution must not:

- mix production and Testnet capital in one workflow;
- infer an asset from its symbol without network identity;
- let model output choose trusted targets or execution truth;
- convert missing provider/RPC data into a mock quote, zero balance, or success;
- treat a submitted transaction hash as economic completion;
- retry an uncertain money movement by broadcasting a new transaction;
- bypass exact account, network, target, spender, amount, deadline, and simulation checks;
- move or modify path-stable submission attachments.

If a dependency or capability is unavailable, return a structured fail-closed state with a useful reason.

## Development commands

Run the narrow package checks while iterating:

```bash
npm run typecheck:api
npm run typecheck:web
npm run lint:web
npm run build:web
npm run compile:base
npm run compile:arc
```

Before opening a pull request, run the CI-equivalent gate:

```bash
npm run verify:core
```

Also run the applicable extended gate:

```bash
npm run verify:labs       # contracts/circuits/research runtime changed
npm run verify:mvp-live   # live configuration or deployment identity changed
npm run check:docs        # documentation or paths changed
```

`verify:mvp-live` is allowed to fail because a real dependency is absent. Record the exact failing capability; do not weaken the gate. A live or funded claim needs the transaction/provider evidence described in the [MVP runbook](docs/runbooks/mvp-live-test.md).

## Code and documentation style

- TypeScript remains strict; web changes pass ESLint.
- Solidity and Soroban changes follow the owning workspace's pinned compiler and deployment procedure.
- Application copy and documentation are English. Localized intent vocabulary stays in allowlisted parser sources.
- Prefer operation-specific validators over a generic trust score or arbitrary-call abstraction.
- Update environment templates, manifests, readiness logic, tests, and docs in the same change when their contract changes.
- Do not edit historical research or submission artifacts to imply current runtime readiness.

## Git and pull requests

1. Branch from `main` with a focused name such as `fix/stellar-recovery` or `feat/base-adapter`.
2. Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(stellar): preserve submitted transfer during recovery`.
3. Keep generated output and unrelated formatting out of the commit.
4. Complete the pull-request template, including affected networks, trust boundaries, migrations, tests, and evidence limits.
5. For value-bearing changes, include reproducible read-only evidence first. Never post secrets or unredacted sensitive logs.

Reviewers should be able to answer: what changed, which network owns it, what authority it has, how failure behaves, what was verified, and what remains unproven.
