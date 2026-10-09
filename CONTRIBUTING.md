# Contributing to Kletia

Kletia coordinates user-authorized finance across networks with different wallet, asset, contract, and finality models. Contributions must preserve those boundaries and distinguish source verification from live or funded evidence.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security vulnerabilities belong in the private process described in [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Use Node.js **22.23.1**, pinned by `.nvmrc`:

```bash
git clone https://github.com/furkan3152/Kletia.git
cd Kletia
nvm use

npm ci                                  # apps and packages (npm workspaces)
npm --prefix contracts/base ci --include=dev --legacy-peer-deps
npm --prefix contracts/arc ci --include=dev --legacy-peer-deps
```

The repository is an npm workspace: `packages/core`, `packages/sdk`, `packages/widget`, `apps/api` and `apps/web` share one root lockfile, and `npm ci` builds the packages. The Hardhat contract workspaces keep their own lockfiles.

Copy the environment templates only for local runtime work:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Never commit environment files, private keys, seed phrases, API keys, webhook secrets, recovery bundles, provider credentials, database dumps, or wallet exports. Browser `VITE_*` values are public.

## Choose the owning boundary

- Chain, asset, protocol and intent-spec changes belong in `packages/core` and must stay dependency-free.
- Network-specific assets, contracts, transaction builders, receipts, and wallet behavior belong in `apps/*/src/networks/<network>`.
- Chain-agnostic planning, adapters, persistence and the `/v1` API belong in `apps/api/src/platform`.
- Shared parsing, HTTP, disclosure, validation, and presentation primitives belong in `shared` only when they do not import protocol identity.
- Client libraries belong in `packages/sdk` (framework-free) and `packages/widget` (React).
- Base and Arc contract workspaces retain separate toolchains, manifests, and operator environments.

Read the [architecture](docs/architecture/overview.md) and [repository ownership rules](docs/architecture/repository-structure.md) before a cross-package change.

## Safety invariants

A contribution must not:

- mix production and Testnet capital in one intent;
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
npm run build:packages
npm run test:packages
npm run typecheck:api
npm run test:api
npm run typecheck:web
npm run lint:web
npm run build:web
npm run compile:base
npm run compile:arc
```

Before opening a pull request, run the CI-equivalent gate:

```bash
npm run verify
```

Also run the applicable extended gate:

```bash
npm run verify:mvp-live   # live configuration or deployment identity changed
npm run check:docs        # documentation or paths changed
```

`verify:mvp-live` is allowed to fail because a real dependency is absent. Record the exact failing capability; do not weaken the gate. A live or funded claim needs the transaction/provider evidence described in the [MVP runbook](docs/runbooks/mvp-live-test.md).

## Code and documentation style

- TypeScript remains strict; web changes pass ESLint.
- Solidity changes follow the owning workspace's pinned compiler and deployment procedure.
- Application copy and documentation are English. Localized intent vocabulary stays in allowlisted parser sources.
- Prefer operation-specific validators over a generic trust score or arbitrary-call abstraction.
- Update environment templates, manifests, readiness logic, tests, and docs in the same change when their contract changes.
- Do not edit historical research or submission artifacts to imply current runtime readiness.

## Git and pull requests

1. Branch from `main` with a focused name such as `fix/solana-confirmation` or `feat/base-adapter`.
2. Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(platform): keep settling steps on relay timeouts`.
3. Keep generated output and unrelated formatting out of the commit.
4. Complete the pull-request template, including affected networks, trust boundaries, migrations, tests, and evidence limits.
5. For value-bearing changes, include reproducible read-only evidence first. Never post secrets or unredacted sensitive logs.

Reviewers should be able to answer: what changed, which network owns it, what authority it has, how failure behaves, what was verified, and what remains unproven.

## Releasing the packages

`@kletia/core`, `@kletia/sdk` and `@kletia/widget` share one version.

1. Bump `version` in all three `packages/*/package.json` files and every `@kletia/*` dependency between them, then run `npm install` so the lockfile follows.
2. Run `npm run build:packages && npm run test:packages && npm run check:packages`.
3. Add a changelog entry, merge to `main`, then push a tag `packages-v<version>`.

`.github/workflows/release-packages.yml` checks the tag against the manifests, tests and inspects the tarballs, and publishes in dependency order with npm provenance (repository secret `NPM_TOKEN`, environment `npm`).
