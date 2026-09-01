# Stellar contract and protocol boundary

This workspace has deliberately separate responsibilities:

- `upstream.lock.json` and `protocol.lock.json` record the confidential-token
  promotion boundary and the reviewed Stellar Testnet protocol identities.
- `policy-receipt-registry` contains Kletia's custody-free terminal receipt
  anchor.
- `intent-control-plane` consumes owner-authorized workflow roots and opaque
  nullifiers without holding funds or claiming foreign-chain truth.
- `policy-verifier-registry` pins immutable circuit/verifier versions and
  dispatches to a circuit-bound BN254 verifier.
- `policy-groth16-verifier` provides that immutable-key pairing verifier. The
  live Testnet deployment uses an explicitly development-only setup; the
  package and key are not a production trusted setup.
- `solver-bond-vault` holds the constructor-pinned Stellar asset that solvers
  voluntarily bond to an exact workflow root. It is application collateral,
  not Stellar validator stake.
- `route-auction` runs a bounded commit-reveal competition and refuses bids
  without a live workflow-scoped bond. It does not make an off-chain quote or
  foreign-chain receipt true by itself.

All four packages are deployed on Stellar Testnet. Exact contract IDs, release
WASM hashes, transactions, VK/circuit bindings and the live proof/finalization
smoke evidence are recorded in
[`deployments/testnet/control-plane.v1.json`](deployments/testnet/control-plane.v1.json).
The runtime re-attests those identities before enabling the control plane.

The two solver-market packages are deployed on Stellar Testnet. Their exact
release hashes, contract identities, immutable constructor bindings and a
faucet-funded register → bond → commit → reveal → finalize → settle → release
lifecycle are recorded
in [`deployments/testnet/solver-market.v1.json`](deployments/testnet/solver-market.v1.json).
The API still re-attests the live WASM and bindings before enabling competitive
selection. This is an unaudited Testnet deployment; no foreign-chain solver
execution or Mainnet safety claim is made. An indeterminate bridge outcome
keeps the bond unresolved and is never converted into automatic slashing.

No private key, fabricated address, placeholder deployment manifest or
confidential-execution flag belongs here.

## Shielded payment runtime

`private-payments.lock.json` pins the exact
`stellar-private-payments@0.1.0-alpha.1` package integrity, source revision,
Testnet XLM/EURC pool identities, Groth16 verifiers, ASP contracts, public-key
registry and license obligations. The application rechecks required live
executables before opening the XLM browser wallet and stages the upstream
workers, circuits, notices and corresponding source into the web build.

This provides a real but unaudited Testnet privacy-pool surface: internal
amounts, balances, spent-note links and recipient-output links are shielded.
Public deposit/withdraw amounts and accounts, timing and possibly transaction
authorization remain observable. There is no Kletia USDC pool, private bridge,
private EVM execution, Mainnet deployment, audit or funded Kletia lifecycle
evidence. The integration must never be promoted beyond that boundary.

## Confidential Token reference status

Stellar's official Confidential Token developer preview includes a working,
unaudited Testnet reference. The linked demo pins OpenZeppelin commit
`539968f158e0d779f584de2821090f715a3b25e1` and Nethermind UltraHonk commit
`661db07200f890b1bd9a7349ed787c70a706dd12`; its native-XLM deployment is
recorded as documentary reference metadata in `upstream.lock.json`. Separately,
OpenZeppelin mainline commit
`fbfde388e1b72afa93d6b1c922067879b20e81db` still exposes an unfinished default
verifier interface. These facts are not contradictory: the working preview is
on a feature/demo path and is not a reviewed Kletia execution dependency.

Kletia's status is therefore `integration_incomplete_non_signable`; upstream
availability is no longer the blocker. `testnetEvaluationAllowed` is true, while
`deploymentAllowed` and `signableRuntimeAllowed` remain false. Kletia has not
deployed a Circle Testnet USDC Confidential Token, verifier or auditor and does
not advertise a working confidential treasury. The upstream demo contract IDs
are reference declarations, not Kletia protocol pins or transaction targets.

The implemented privacy guarantee is narrower: selected planning fields are
kept out of the semantic-model request, while public CCTP, SDEX and Aave
settlement remains visibly public. A public Stellar hop receives zero privacy
credit. Configuration alone cannot promote the confidential surface.

Promotion requires an exact pinned holder SDK, reproducible Kletia-specific
USDC wrapper/verifier/auditor WASM, circuit/VK hashes, safe Kletia auditor key
material, exact contract identities, administration policy, license inventory,
canonical event archival, clean-device recovery, adversarial
proof/replay/recovery tests and a real signed Stellar Testnet lifecycle. The
demo's intentionally published auditor material must never be reused. Mainnet
confidentiality, anonymity and real-asset security are outside the current
claim.

## Public protocol locks

Circle's official Stellar Testnet `TokenMessengerMinter`,
`MessageTransmitter` and `CctpForwarder` identities come from Circle's
deployment reference. Their live-observed WASM hashes are pinned in
`protocol.lock.json`; a mismatch quarantines the execution capability. A hash
match proves only that the deployed bytecode is unchanged from the recorded
observation. It is not source-code review, a security audit or an economic
correctness guarantee.

The Circle Testnet USDC SAC is derived from its exact classic `code + issuer`
identity and is checked as a Stellar Asset executable. The Aquarius Testnet
router is observation-only and unpinned; its centralized API response is used
only as untrusted read-only comparison evidence. Aquarius execution remains
disabled. Blend is not included because the reviewed Testnet fixture uses a
mock SAC reserve and mock oracle instead of Circle Testnet USDC.

These locks and read-only observations do not constitute a funded,
user-signed Arc -> Stellar -> Arbitrum Sepolia -> Aave lifecycle. That remains
a separate release gate.

## Policy Receipt Registry

[`policy-receipt-registry`](policy-receipt-registry/README.md) stores an
owner-authorized manifest hash and privacy-budget hash under a monotonic nonce,
then permits the owner to finalize it with one receipt hash before a separate
receipt-close deadline. Execution expiry closes new execution first; the later
receipt window permits only terminal owner acknowledgement and never reopens
execution. It holds no funds and grants no approval, signing or agent authority.
All records and events are public, so the registry adds linkage and does not
create confidentiality.

The source package has passed host tests, formatting, Clippy and a release WASM
build. The reviewed release artifact SHA-256 is
`723d052be3e3f2585050337607fc3c010f18395825bf434693e863a81d27319d`.
The Testnet deployment is live. The API keeps the capability closed unless
`STELLAR_POLICY_REGISTRY_ENABLED=true`, the exact
`STELLAR_POLICY_REGISTRY_CONTRACT_ID` is configured, Stellar RPC reports the
Testnet passphrase, and the live contract executable equals that exact hash.
An absent or drifted binding remains fail-closed.

This readiness check is not transaction integration and does not turn the
registry into a verifier. Even after deployment, a finalized opaque hash would
show only what the owner authorized; it would not prove an EVM transaction,
CCTP attestation, Aave position, Stellar operation, confidential preimage or AI
decision without independent evidence verification.

```bash
cargo fmt --manifest-path contracts/stellar/policy-receipt-registry/Cargo.toml -- --check
cargo test --manifest-path contracts/stellar/policy-receipt-registry/Cargo.toml
cargo clippy --manifest-path contracts/stellar/policy-receipt-registry/Cargo.toml --all-targets -- -D warnings
```

Any deployment must record the network passphrase, contract ID, source
revision, reproducible WASM hash, build toolchain and deployment transaction.
Signer material must never be stored in this directory or committed to git.

## Intent Control Plane and Policy Verifier Registry

[`intent-control-plane`](intent-control-plane/README.md) records a single
workflow root and policy root, consumes its nullifier exactly once, and permits
only owner-authorized finalization or cancellation. Its constructor pins the
Policy Verifier Registry, and `commit` constructs the exact nine circuit public
inputs before requiring a successful registry proof. A cancelled workflow never
releases its nullifier for reuse. This protects Kletia's registry lifecycle; it
cannot prevent a user from sending an unrelated transaction directly on a
foreign chain.

The application compiler may derive the public `workflow_root` with a
domain-separated hash-to-BN254-field mapping. It must not derive `policy_root`,
`nullifier`, registry roots or `execution_context_commitment` from a JSON hash:
those are circuit outputs/public inputs produced from the device-private
Poseidon witness. The proof-binding transition simulates the
exact nine inputs against the pinned registry, persists hashes rather than the
proof, and only then permits the browser to hydrate the exact commit/finalize
XDR calls through recording and enforcing simulation. The current deployment is
Testnet-development only; it fails closed on any contract, WASM, circuit, VK,
schema or constructor-binding drift and must not be promoted to Mainnet.

[`policy-verifier-registry`](policy-verifier-registry/README.md) pins each
policy circuit version to exact verifier, VK, circuit and public-input-schema
hashes. Verification is dispatched to the pinned verifier contract and fails
closed for missing or disabled versions. The current policy circuit under
`circuits/stellar-policy` compiles to R1CS/WASM and its range, cap and
execution-context constraints have executable witness tests.
[`policy-groth16-verifier`](policy-groth16-verifier/README.md) implements the
immutable-key BN254 equation and passes a real snarkjs/Soroban pairing vector.
That vector comes from an unsafe single-contributor local setup; no production
setup, production VK or deployment is claimed.

Future runtime promotion requires more than matching all four reviewed WASM
hashes. The API also simulates `get(version)`, compares the enabled onchain
record with the reviewed circuit/schema/input layout and exact VK, then checks
the circuit-bound verifier's live WASM hash. A boolean artifact flag alone cannot
open the `zk_verified` control-plane capability.

## Licenses and sources

Kletia and the Policy Receipt Registry are MIT licensed. Any future
OpenZeppelin-derived implementation must retain upstream attribution and its
exact source commit.

- [OpenZeppelin pinned confidential source](https://github.com/OpenZeppelin/stellar-contracts/tree/fbfde388e1b72afa93d6b1c922067879b20e81db/packages/tokens/src/confidential)
- [Official Confidential Token developer preview](https://stellar.org/blog/developers/developer-preview-confidential-tokens-on-stellar)
- [Official linked Testnet demo](https://github.com/brozorec/stellar-confidential-token-demo/tree/9500ed774b13b08b5fe99370b60de3479edb492b)
- [Stellar privacy documentation](https://developers.stellar.org/docs/build/apps/privacy)
- [Circle CCTP Stellar contracts](https://developers.circle.com/cctp/references/stellar-contracts)
## Policy V2 release boundary

`control-plane-v2.lock.json` pins the twelve-input policy circuit, browser
prover, immutable verifier, verifier registry and Intent Control Plane V2
artifacts. `scripts/deploy-control-plane-v2-testnet.sh` performs a no-write
preflight by default and requires a separate explicit confirmation before it
deploys or registers anything. A successful script run is still not enough to
open the feature: the API live-readiness probe and a real owner-signed Testnet
commit/finalize lifecycle must pass first.

Those Testnet gates passed on 2026-08-24. Exact contract IDs, release
transactions, verifier registration, live executable observations and the
real Groth16 `commit → finalize` smoke are recorded in
[`deployments/testnet/control-plane.v2.json`](deployments/testnet/control-plane.v2.json).
This remains an unaudited, single-contributor Testnet setup and does not prove
foreign-chain execution or provide ledger confidentiality.
