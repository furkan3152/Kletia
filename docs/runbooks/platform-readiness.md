# Platform readiness report — 2026-10-10

The implementation expands Kletia to **33 protocol integrations across nine
networks**, with Solana as the first app/Studio workspace. The protocol endpoint
also describes two custom integration types; these are separate from the 33
protocols. Integrator contract registrations stay in the integrator's project
and do not enter the first-party execution catalog.

## Delivered behavior

| Addition | Execution boundary |
|---|---|
| Raydium | Solana mainnet direct ExactIn swaps through reviewed CLMM/CP pools; classic SPL/native SOL, a single pool, 1–300 bps |
| Orca | Solana mainnet direct ExactIn swaps through reviewed Whirlpool variants; classic SPL/native SOL, a single pool, 1–300 bps |
| SparkLend | Ethereum USDC/WETH supply and exact/full withdrawals with reserve, approval, simulation and receipt checks |
| Yearn V3 | Ethereum curated USDC-1 deposit and exact/full withdrawals with official endorsement and explicit withdrawal loss limits |

Named destination DEXs remain bound to their own step after a bridge. Complex
route regressions cover five-step bridge/swap/bridge/deposit dependencies,
partial amounts, forbidden venues and cross-network funding errors.

Custom execution is refused by the first-party console, Studio and shared
links. The integrator's SDK/widget and exact hosted embed intent/session can
prepare its own registered contract after the current key, owner, ancestor and
project checks. Session creation also requires a proven host channel. Review
and wallet signing remain user-controlled.

PostgreSQL webhook jobs retain sealed bodies, persisted retries and fenced
leases across restart. Authorization is rechecked on every attempt; temporary
owner-store failures preserve work. The initial source mutation and queue
insertion are separate transactions, SSE is process-local, and receiver-side
event-id deduplication is required. See [API guarantees](../platform/api-v1.md).

Arc has separate safe Swap/Staking/Lending V2 sources. They add minimum output
and expiry, prospective APR accounting and stale-oracle guards. Exact compiled
runtime pins bind the constructor token/forwarder; arbitrary operator hashes
cannot authorize a deployment. Historical balances remain visible and explicit
legacy exits keep their original targets. [Activation and boundaries](../networks/arc-defi-v2-readiness.md).

## Validation

`npm run verify` passed on the frozen source with PostgreSQL enabled:

| Suite | Passed | Skipped |
|---|---:|---:|
| Core / SDK / widget / embed / CLI | 350 | 1 optional live receipt-anchor test |
| API (including PostgreSQL) | 985 | 0 |
| Web review/embed/Arc boundary regressions | 38 | 0 |
| Base / Arc contracts | 81 | 0 |
| Chromium desktop/mobile journeys | 40 | 0 |

The combined suites passed 1,494 tests and scenarios. Browser journeys include
20 desktop and 20 mobile cases, with no uncaught exception or wallet
signature/broadcast request.

Structure and documentation, privacy egress and traces, package tarballs,
OpenAPI/collection drift, intent schema/network/user-journey matrices, API/web
typechecks and builds, web lint and bundle budget, Solidity compilation and
reviewed Arc runtime-pin drift checks all passed.

Both API and web runtime images built successfully. The Node user (UID 1000)
could read all 375 API and 337 web runtime files. API smoke checks covered
health, protocol discovery and PostgreSQL-backed key issuance, authentication
and listing. Web checks covered SPA routes, public branding/actions/key-mirror
assets and the entry bundle, including MIME, CORS, framing, robots and cache
headers. Runtime file permissions and the fixed-loopback Docker/Compose health
probe were corrected during this validation.

Registry HTTP 503 responses prevented a fresh remote image/dependency build.
Container validation therefore used temporary cache-backed build files, the
same pinned Node 22.23.1 Alpine 3.24 base, and Linux/Alpine npm objects checked
against the unchanged lockfile integrity values. It verifies the cached build
and runtime, not current registry availability. No cache or build credential
is part of the committed project.

Runtime dependency audits reject no high or critical advisories. The workspace
still reports 8 low and 37 moderate advisories, mainly in wallet dependency
trees; both contract package runtime audits report zero. These counts describe
the dependency audit, not an external code audit.

The reproducible commands are:

```bash
npm ci
npm --prefix contracts/base ci --include=dev --legacy-peer-deps
npm --prefix contracts/arc ci --include=dev --legacy-peer-deps
KLETIA_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/kletia_test npm run verify
npx playwright install chromium
npm run test:e2e
```

The PostgreSQL URL must point to a dedicated test database. CI provisions it
and runs the same static verification, contracts and desktop/mobile browser
suite. Browser fixtures test authorization/review flows without financial
execution.

## Live observations and release needs

- [Ethereum evidence](../networks/evidence/evm-lending-additions.json): 17 successful Spark/Yearn contract reads, block 26160576, official venue identities and runtime hashes.
- [Solana evidence](../networks/solana.md): both named venues successfully quoted, validated and prepared an unsigned 0.01 SOL → USDC swap at 50 bps with independent RPC simulation and real venue CPI evidence.
- [Full preflight snapshot](../networks/evidence/platform-preflight-2026-10-10.json): Base router, Arbitrum Sepolia bindings and primary Solana RPC passed. The full report is **blocked by unconfigured Arc DeFi V2 deployments**.
- Later live network access also returned HTTP 503 for registry, Git and RPC calls in the execution environment. The successful preflight above is an observation at its recorded timestamp; it is not a current availability guarantee.
- The optional SDK live receipt-anchor test was attempted separately. Its four default public RPCs returned HTTP 503 for historical transaction lookups. The result is unavailable, not a verified live receipt; offline signature/anchor regressions remain part of the normal suite.

A public release still requires separately deploying the Arc DeFi V2 contracts
and setting their reviewed identities, production RPC capacity, PostgreSQL and
a stable platform secret. Configure the provider credentials for the enabled
features, including Relay/Across and consented AI interpretation. Production
receipts require an operator-generated signing key and matching published key
mirrors. x402 requires its payment recipient and CDP credentials.

No wallet was signed, funded operation broadcast, package published or public
service deployed during this work. Builds and read-only observations do not
establish a funded financial lifecycle or an external security audit.
