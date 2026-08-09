# Kletia Base V2 release and verification runbook

This runbook is the production boundary for the non-upgradeable Kletia Base
contracts. The source tree is deployable, but a contract is **not** a production
deployment until every gate below is complete and its exact source is verified
on a Base explorer. Verification is evidence of source equivalence, not a
security audit.

All Kletia V2 Solidity sources use the MIT SPDX identifier. The reproducible
compiler profile is Solidity `0.8.24`, Cancun EVM, optimizer enabled with 200
runs.

## Canonical Base Mainnet deployment record

The current non-secret deployment and Timelock operation record is stored in
`deployments/base-mainnet-v2.json`. That file is the repository handoff source;
do not copy addresses, salts or timestamps from chat transcripts or external
agent reports.

The recorded Uniswap canary is presently in the `configure_scheduled` state.
Until both `configureAdapter(adapter, false)` and the separately delayed
`enableAdapter(adapter)` operation have executed, keep the backend and frontend
release modes at `legacy_v1` and keep runtime evidence unset. After enablement,
the manifest-bound exporter can be run with:

```bash
npm run evidence:v2:base:deployment
```

The exporter still validates every live invariant; the manifest never makes a
pending or drifted deployment executable by itself.

This pending swap state does not quarantine the two independent deployments.
`KletiaLaunchFactoryV2` is connected through the explicit `launch_v2` token
deployment mode and its own live evidence exporter; the legacy token factory is
not simultaneously authorized. The x402 attestation registry is connected as
a Base-only, read-only supplemental claim verifier. Neither connection grants
the pending intent router execution authority or changes Arc Testnet behavior.

## Governance topology

| Role | Production account | Capability |
|---|---|---|
| Owner | OpenZeppelin `TimelockController`, minimum delay `172800` seconds | Adapter enable/configure, unpause, fee/treasury/governance changes and paused rescue |
| Proposer/canceller | Governance Safe | Schedule or cancel Timelock operations |
| Executor | Open execution role (`address(0)`) | Execute an already mature operation; cannot schedule one |
| Guardian | Separate security Safe | Pause the router and disable adapters only |
| Treasury | Separate treasury Safe | Receive transparent protocol fees; no governance authority |

Deploy `TimelockController` with the Governance Safe as proposer,
`address(0)` as executor and no external admin. The Timelock remains its own
administrator. Never use a production EOA as router, factory or registry owner.
The Guardian and Treasury must not be the router, an adapter, a protocol target,
a factory, WETH or a traded token.

Deploy these contracts directly, never behind a proxy:

- `KletiaIntentRouterV2`
- every typed protocol adapter
- `KletiaLaunchFactoryV2`
- `KletiaX402ServiceAttestationRegistryV1`

The x402 registry is supplemental discovery evidence only. Coinbase CDP Bazaar
remains the canonical x402 discovery source; this registry never verifies,
settles or escrows a payment.

## Uniswap V3 release quarantine

> **EXPERIMENTAL_NOT_RELEASED**
>
> `UniswapV3SwapRouter02Adapter` remains **production deploy/enable
> forbidden**. It must not be passed to production `configureAdapter`, enabled
> or included in a production intent response until the remaining external
> release gates below are complete.

The local schema-v2 evidence exporter, canonical packed-path builder, runtime
identity validation, response-envelope projection, frontend execution binding
and adversarial unit tests are implemented. That is implementation evidence,
not production evidence. The quarantine remains until a recorded Base Mainnet
fork suite proves the exact official router/factory/pools and a release review
is closed against the deployed Base Mainnet topology. No Base Sepolia deployment
is part of this release path, and no operator label or opaque calldata may
bypass this boundary.

## First swap-adapter set

The first production canary should configure only separately deployed
`UniswapV2CompatibleAdapter` instances whose constructor identities are proven
on Base:

| Protocol ID | Router/spender | Factory | Initial state |
|---|---|---|---|
| `uniswap` | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` | Canary enable |
| `pancakeswap` | `0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb` | `0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E` | Disabled until its fork suite passes |
| `sushiswap` | `0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891` | `0x71524B4f93c58fcbF659783284E38825f0622859` | Disabled until its fork suite passes |

Runtime evidence schema v1 intentionally exports only the `uniswap` canary.
PancakeSwap or SushiSwap cannot be activated merely by adding their label to
an environment variable; each requires its recorded fork suite and a reviewed
evidence-policy version change first.

Every instance pins canonical Base WETH
`0x4200000000000000000000000000000000000006`. AlienBase, BaseSwap and
SwapBased quotes must remain ineligible for V2 until their exact router,
factory, source and runtime identity receive the same primary-source and fork
review. A factory address is never an execution router.

Uniswap V3, Pancake V3, Aerodrome and Slipstream require distinct typed
adapters. Their calldata must never be passed through the V2 router as opaque
bytes. 0x, 1inch and Odos API calldata is explicitly outside the router adapter
allowlist.

Schema v2 is an explicit opt-in for the separately typed official Uniswap V3
candidate. It pins Base SwapRouter02
`0x2626664c2603336E57B271c5C0b26F421741e481`, V3 Factory
`0x33128a8fC17869897dcE68Ed026d694621f6FDfD` and canonical WETH9. It does not
authorize Pancake V3, Aerodrome, Slipstream or a generic V3 router.

## Release gates

1. Pin a clean release commit and record the repository commit, lockfile hash
   and Hardhat `build-info` hash.
2. Run all unit/adversarial tests using the supported Node version.
3. Pin and review the resolved production dependency tree. Major-only
   Hardhat/toolbox remediation must be a separately reviewed migration with
   regenerated build info and full fork regression; never run an automatic
   forced dependency rewrite during a release.
4. Run a Base mainnet fork suite at one recorded block for every intended
   adapter: constructor identity, pair/pool existence, exact-input execution,
   fee behavior, codehash and allowance reset.
5. Close the recorded contract and application release review. An external
   audit may be commissioned separately, but this runbook does not invent one
   as a deployment prerequisite or claim that internal tests prove “zero
   vulnerabilities”.
6. Exercise Timelock delay, guardian pause/disable, nonce invalidation, exact
   approvals, ERC-1271, treasury acceptance and emergency procedures against a
   pinned local fork of the deployed Base Mainnet topology. Do not deploy this
   release to Base Sepolia.
7. Deploy production Safes and the 48-hour Timelock. Record their policies and
   signer threshold outside this repository.
8. Deploy adapters, then the router with the Timelock as initial owner. Use a
   bounded initial fee (the current application policy is 10 bps); the contract
   hard cap is 100 bps.
9. Verify exact source for every Kletia deployment before scheduling any
   adapter configuration.
10. Schedule `configureAdapter(adapter, false)` through the Timelock. After
   independent bytecode/evidence review, schedule `enableAdapter(adapter)`.
11. Export the live runtime evidence only after the enable transaction is
    confirmed.
12. Activate a small Uniswap V2 canary. Observe successful and reverted
    executions, fee accounting, nonce use and security scans before expanding.

There is no automatic V2-to-V1 fallback. An operator may perform an explicit,
announced configuration rollback by setting `BASE_SWAP_EXECUTION_MODE` back to
`legacy_v1`; this is a release decision, not a runtime recovery path.

## Exact-source verification

Set the explorer API credential in the shell or CI secret store. Do not place a
deployment private key in this repository or in a frontend variable.

```bash
npx hardhat compile
npx hardhat verify --network base <ADAPTER_ADDRESS> \
  <PROTOCOL_ROUTER> <PROTOCOL_FACTORY> \
  0x4200000000000000000000000000000000000006

npx hardhat verify --network base <ROUTER_ADDRESS> \
  <TIMELOCK_ADDRESS> <GUARDIAN_SAFE> \
  0x4200000000000000000000000000000000000006 \
  <TREASURY_SAFE> <INITIAL_FEE_BPS>
```

Verify the Launch Factory and x402 Registry with their exact constructor
arguments if they are part of the release. Save the explorer URL, compiler
settings, constructor arguments and deployed runtime codehash in the signed
release record. Confirm the explorer reports an exact match; a submitted or
pending verification is not sufficient.

## Runtime evidence export and application cutover

The exporter is read-only and requires no signer:

```bash
export KLETIA_V2_ROUTER_ADDRESS=<ROUTER_ADDRESS>
export KLETIA_V2_TIMELOCK_ADDRESS=<TIMELOCK_ADDRESS>
export KLETIA_V2_GOVERNANCE_SAFE=<GOVERNANCE_SAFE>
export KLETIA_V2_GUARDIAN_SAFE=<GUARDIAN_SAFE>
export KLETIA_V2_TREASURY_SAFE=<TREASURY_SAFE>
# Mandatory exact canary policy; the first release policy is 10 bps.
export KLETIA_V2_EXPECTED_FEE_BPS=10
export KLETIA_V2_ADAPTERS_JSON='[
  {"kind":"uniswap_v2_compatible","protocolId":"uniswap","adapter":"<ADAPTER_ADDRESS>"}
]'
npm run evidence:v2:base
```

It refuses the wrong chain, missing code, paused router, disabled adapter,
identity drift, Router02 factory/WETH drift, noncanonical Base WETH, any
codehash mismatch, a Timelock shorter than 48 hours, an EOA/one-signer role,
an active pending router-owner transfer, a live fee different from the required
decimal `KLETIA_V2_EXPECTED_FEE_BPS` policy, or
governance/guardian/treasury capability overlap. Safe module/guard policy
and the complete Timelock role event history still require an independent
release review; read-only interface checks cannot prove their absence. Store
the exporter's single-line JSON output as the server-only
`KLETIA_INTENT_ROUTER_V2_EVIDENCE_JSON`.

Cut over only after a second operator compares the exported addresses and
hashes with the verified explorer records:

```text
BASE_SWAP_EXECUTION_MODE=intent_v2
KLETIA_INTENT_ROUTER_V2_ADDRESS=<ROUTER_ADDRESS>
KLETIA_INTENT_ROUTER_V2_EVIDENCE_JSON=<EXPORTED_SINGLE_LINE_JSON>
VITE_BASE_SWAP_EXECUTION_MODE=intent_v2
```

`BASE_SWAP_EXECUTION_MODE` and the frontend build-time
`VITE_BASE_SWAP_EXECUTION_MODE` are one atomic release decision. Never deploy a
mixed pair. While both remain `legacy_v1`, the frontend rejects typed V2
responses. After the coordinated `intent_v2` cutover, it rejects every untyped
Base swap except the separately rebound canonical Base WETH deposit/withdraw
primitive.

At runtime the backend refreshes the V2 evidence at one pinned Base block,
validates live fee/pause/adapter state, selects an unused unordered nonce and
builds typed calldata. If any proof fails, the request stops; it does not emit a
legacy route. The frontend independently enforces the release mode, so a fully
marker-stripped response cannot silently downgrade into a direct swap.

## Emergency procedure

1. Guardian pauses the router or disables only the affected adapter.
2. The backend remains fail-closed. Do not conceal the incident by automatically
   changing execution mode.
3. Publish the affected adapter, block and transaction range.
4. Governance schedules the corrective action through the 48-hour Timelock.
5. Re-run fork tests, exact-source/codehash review and runtime evidence export
   before unpausing or re-enabling.

Asset rescue is available only while paused and only through delayed owner
governance. It is not a substitute for balance reconciliation or user
reimbursement policy.
