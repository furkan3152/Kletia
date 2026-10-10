# Platform readiness (2026-10-10)

Kletia now has 33 protocol integrations across nine networks, and Solana is
the default app and Studio workspace. The protocol endpoint also describes two
custom integration types; they are not counted among the 33 protocols.
Integrator contract registrations stay in the integrator's project and do not
enter the first-party execution catalog.

## What shipped

| Addition | Execution boundary |
|---|---|
| Raydium | Solana mainnet direct ExactIn swaps through reviewed CLMM/CP pools; classic SPL/native SOL, a single pool, 1–300 bps |
| Orca | Solana mainnet direct ExactIn swaps through reviewed Whirlpool variants; classic SPL/native SOL, a single pool, 1–300 bps |
| SparkLend | Ethereum USDC/WETH supply and exact/full withdrawals with reserve, approval, simulation and receipt checks |
| Yearn V3 | Ethereum curated USDC-1 deposit and exact/full withdrawals with official endorsement and explicit withdrawal loss limits |

A destination DEX named in the request stays bound to its own step after a
bridge. Route regression tests cover five-step bridge/swap/bridge/deposit
dependencies, partial amounts, forbidden venues and cross-network funding
errors.

The first-party console, Studio and shared links refuse custom execution. The
integrator's SDK/widget and the exact hosted embed intent/session can prepare
its own registered contract after the current key, owner, ancestor and project
checks. Creating a session also requires a proven host channel. Review and
wallet signing stay with the user.

With PostgreSQL, webhook jobs keep sealed bodies, persisted retries and fenced
leases across restarts. Authorization is checked again on every attempt, and a
temporary owner-store failure keeps the job. The source mutation and the queue
insert are separate transactions, SSE is process-local, and receivers must
deduplicate by event id. See [API guarantees](../platform/api-v1.md).

Arc has separate Swap/Staking/Lending V2 sources. They add minimum output and
expiry, prospective APR accounting and stale-oracle guards. Exact compiled
runtime pins bind the constructor token and forwarder, so an arbitrary
operator hash cannot authorize a deployment. Historical balances stay visible
and explicit legacy exits keep their original targets. See
[activation and boundaries](../networks/arc-defi-v2-readiness.md).

## Validation

`npm run verify` passed with PostgreSQL enabled:

| Suite | Passed | Skipped |
|---|---:|---:|
| Core / SDK / widget / embed / CLI | 350 | 1 optional live receipt-anchor test |
| API (including PostgreSQL) | 985 | 0 |
| Web review/embed/Arc boundary regressions | 38 | 0 |
| Base / Arc contracts | 81 | 0 |
| Chromium desktop/mobile journeys | 40 | 0 |

That is 1,494 tests and scenarios in total. The browser journeys are 20
desktop and 20 mobile cases; none raised an uncaught exception or made a
wallet signature or broadcast request.

The same run covers structure and documentation, privacy egress and traces,
package tarballs, OpenAPI/collection drift, the intent schema/network/user
journey matrices, API and web typechecks and builds, web lint and the bundle
budget, Solidity compilation and the reviewed Arc runtime-pin drift check.

Both the API and web runtime images build. The Node user (UID 1000) can read
all 375 API and 337 web runtime files. API smoke checks cover health, protocol
discovery and PostgreSQL-backed key issuance, authentication and listing. Web
checks cover SPA routes, public branding/actions/key-mirror assets and the
entry bundle, including MIME, CORS, framing, robots and cache headers. This
release also fixes the runtime file permissions and the fixed-loopback
Docker/Compose health probe.

The images were built from a local npm cache on the pinned Node 22.23.1 Alpine
3.24 base; the cached Linux/Alpine packages match the lockfile integrity
values. No cache or build credential is committed.

Runtime dependency audits report no high or critical advisories. The
workspace still has 8 low and 37 moderate advisories, mostly in wallet
dependency trees; both contract packages report zero runtime advisories. These
numbers come from the dependency audit, not an external code audit.

To reproduce:

```bash
npm ci
npm --prefix contracts/base ci --include=dev --legacy-peer-deps
npm --prefix contracts/arc ci --include=dev --legacy-peer-deps
KLETIA_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/kletia_test npm run verify
npx playwright install chromium
npm run test:e2e
```

Point the PostgreSQL URL at a dedicated test database. CI provisions one and
runs the same static verification, contract tests and desktop/mobile browser
suite. The browser fixtures exercise authorization and review flows without
executing anything financial.

## Live observations

- [Ethereum evidence](../networks/evidence/evm-lending-additions.json): 17 successful Spark/Yearn contract reads at block 26160576, with official venue identities and runtime hashes.
- [Solana evidence](../networks/solana.md): both named venues quoted, validated and prepared an unsigned 0.01 SOL → USDC swap at 50 bps, with independent RPC simulation and real venue CPI evidence.
- [Full preflight snapshot](../networks/evidence/platform-preflight-2026-10-10.json): the Base router, Arbitrum Sepolia bindings and the primary Solana RPC passed. The full report is blocked by the unconfigured Arc DeFi V2 deployments. The snapshot is only valid at its recorded timestamp.
- The optional SDK live receipt-anchor test has no passing run yet: its four default public RPCs answer HTTP 503 for historical transaction lookups. The offline signature/anchor regressions stay in the normal suite.

## Before a public release

- Deploy the Arc DeFi V2 contracts and set their reviewed identities.
- Provide production RPC capacity, PostgreSQL and a stable platform secret.
- Configure provider credentials for the enabled features, including Relay/Across and consented AI interpretation.
- For production receipts, generate an operator signing key and publish matching key mirrors.
- For x402, set the payment recipient and CDP credentials.

Nothing has been published or deployed publicly, and no funded transaction has
been broadcast. Builds and read-only checks are not a substitute for a funded
end-to-end run or an external security audit.
