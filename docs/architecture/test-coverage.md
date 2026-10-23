# Test coverage

Line and branch coverage of the API and the workspace packages, measured with Node's built-in coverage (`--experimental-test-coverage`). The numbers are informational: no build fails on them.

## Measuring

```bash
npm run build:packages   # packages are measured through dist; source maps point back at src
npm run test:coverage    # runs the suites, then prints the table below
```

`tooling/test-coverage.mjs` runs the API suite (`apps/api`, the same files as `npm run test:api`) and each package's `test/*.test.mjs` with the lcov reporter, then sums lines and branches per area. Test files and other workspaces loaded by a suite are left out. The API's `src` row is everything under `apps/api/src` outside the named areas (network modules and shared code the platform tests load). `packages/embed` tests its minified bundle, which has no source map, so it reports no source lines.

Node counts type-only lines of a mapped TypeScript file as uncovered, so files that only declare types read low; compare runs with each other, not with other tools.

## Round 9 (security hardening)

Before: commit `8a9410d`. After: this round's hardening commit. Both runs on the same machine; the platform suites have a few timing-dependent paths, so differences of a few lines between identical runs are noise.

| Area | Lines before | Lines after | Branches before | Branches after |
|---|---|---|---|---|
| apps/api/src/platform/http | 82.34% (25327/30760) | 82.37% (25341/30763) | 82.32% (5193/6308) | 82.48% (5226/6336) |
| apps/api/src/platform/engine/adapters | 89.98% (15710/17459) | 90.13% (15740/17463) | 77.81% (3988/5125) | 78.06% (4023/5154) |
| apps/api/src/platform/engine (other) | 91.44% (28894/31600) | 91.47% (28903/31600) | 87.16% (11802/13541) | 87.21% (11802/13533) |
| apps/api/src/admin | 82.39% (2970/3605) | 82.39% (2970/3605) | 73.90% (838/1134) | 73.90% (838/1134) |
| apps/api/src (rest) | 51.85% (8395/16191) | 51.89% (8407/16202) | 62.82% (713/1135) | 62.95% (717/1139) |
| packages/core/src | 93.23% (18586/19935) | 93.31% (18602/19935) | 86.55% (5362/6195) | 86.97% (5421/6233) |
| packages/sdk/src | 93.79% (5620/5992) | 93.79% (5620/5992) | 79.88% (1505/1884) | 79.88% (1505/1884) |
| packages/widget/src | 82.28% (5177/6292) | 82.49% (5190/6292) | 69.85% (1091/1562) | 69.90% (1096/1568) |
| packages/cli/src | 92.21% (4295/4658) | 92.21% (4295/4658) | 66.75% (1086/1627) | 66.79% (1086/1626) |

The new tests target security-relevant behaviour rather than line counts: seeded property tests of amounts, slippage, base58, base64url, hex, SHA-256, keccak-256 / EIP-55, CAIP identities and webhook signatures (`packages/core/test/properties.test.mjs`); the edges of every blocked address range, IPv4 hidden in IPv6, both URL policies and the connect-time lookup (`netguard.test.ts`); rate-limit windows, stream slots, client identity and Idempotency-Key reservations (`limitPrimitives.test.ts`); secret sealing (`secretSealing.test.ts`); and unprepared steps, outcome-check reporting, prepared bindings and floors, the landed-payload record and Solana transfer credits in verification (`verificationEdges.test.ts`).

## Where coverage is thin

- Postgres stores (`*/store.ts`, `webhookQueue.ts`, policy ledgers and decisions, receipts store): the suites run the memory stores; the Postgres paths run in `*Pg.test.ts` only when a database is configured.
- `contractChecks.ts` provider calls (Sourcify, explorers) and `links/watcher.ts`: network paths without recorded fixtures yet.
- `links/blinks.ts` branches and the Jupiter / Solana transfer `prepare` paths: they need Solana RPC fixtures for transaction building.
