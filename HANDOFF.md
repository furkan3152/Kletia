# Kletia handoff — 2026-10-10

Working branch: `feat/solana-platform-readiness`, based on main
`31e6782f059fe15f7aaafac5c16b0e1f6fe9be5a`.

## Current implementation

- Nine networks, **33 protocols** and two separate custom integration types. New actual adapters: Raydium and Orca on Solana; SparkLend and Yearn V3 on Ethereum.
- Named local DEXs remain bound across bridge optimization; multi-step, partial-amount and network-funding regressions are included.
- Solana is the first app/Studio workspace; saved network and wallet preferences remain valid.
- Integrator contracts stay in their private/project scope. Main console, Studio and links refuse custom execution; scoped SDK/widget/embed flows preserve review and wallet authority. Prepare rechecks current owner, caller, ancestor and project authorization.
- PostgreSQL webhook delivery queue: sealed bodies, fenced claims, persisted retries, restart recovery and fresh authorization on every attempt. Source graph mutation and queue insertion are not an atomic outbox; SSE remains process-local.
- Separate Arc Swap/Staking/Lending V2 sources fix slippage/deadline, retroactive APR accounting and stale oracle handling. Exact compiled runtime pins bind canonical constructor identities. Original deployed sources/manifests remain unchanged. New exposure is disabled until separately deployed V2 identities are configured; historical balances and explicit exits remain available.
- Regressions caught and fixed native SOL rent/output accounting, transient webhook owner lookup drops, retry authorization, historical Arc position visibility, oracle-outage exits and the legacy Vault withdrawal parser.

## Verification

The frozen-source `npm run verify` passed with a dedicated PostgreSQL test DB:
985 API, 350 package, 38 web and 81 Base/Arc contract tests. One optional SDK
live receipt-anchor test is skipped by default; its separate live attempt was
blocked by public RPC HTTP 503 responses. Chromium desktop/mobile passed all
40 permanent authorization/review/journey scenarios. See the final browser and
image results in [the readiness report](docs/runbooks/platform-readiness.md).

CI provisions PostgreSQL, runs contract tests/runtime-pin drift checks and
installs Chromium for desktop/mobile journeys. Runtime audits have zero
high/critical findings; low/moderate wallet-dependency advisories remain.

## Live evidence and outstanding operator work

[Readiness report](docs/runbooks/platform-readiness.md) links the immutable
Ethereum read-only evidence and the full preflight snapshot. Spark/Yearn had
17 successful contract reads; Raydium/Orca both produced unsigned simulated
swaps with actual venue CPI proof. Base router, primary Solana RPC and
Arbitrum Sepolia preflight passed. Full live readiness is blocked by the
unconfigured Arc DeFi V2 deployments. Later external access returned HTTP
503 across Git/registry/RPC calls in this execution environment.

Deploy the new Arc V2 contracts according to
[the migration runbook](contracts/arc/DEFI_V2_MIGRATION.md), then configure API
address/hash pairs and the matching public VITE addresses. Configure
production RPCs, PostgreSQL, a stable platform secret, enabled provider keys,
x402 treasury/CDP, and an operator-generated receipt signing key with matching
published key mirrors. Packages and public services have not been released by
this change. No funded wallet operation or public contract deployment was run.

The API holds no user wallet keys. SDK/widget signers delegate transactions to
the user's own wallet. This project has not had an external security audit.

## Run and verify

```bash
npm ci
npm run dev:api
npm run dev:web
KLETIA_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/kletia_test npm run verify
npx playwright install chromium
npm run test:e2e
```

Self-hosting: [Docker Compose](docs/deployment/self-hosting.md).
