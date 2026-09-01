# Kletia Policy Circuits

`KletiaPolicyV1.circom` proves a deliberately narrow policy statement: a hidden
amount is within hidden committed lower/upper bounds, the selected
protocol/asset/recipient belong to pinned Poseidon Merkle registries, the lane
and ledger expiry are bound into the policy, and a workflow-scoped nullifier
was derived consistently. The hidden amount, selected leaves, lane, expiry and
workflow are also bound into one `executionContextCommitment`; this lets a
later independently verified receipt compare against one immutable planned
context without pretending that this circuit observed a foreign chain. Amount,
minimum and maximum are each constrained to canonical 64-bit integers. The
circuit does not accept a caller-selected
"current time". The Soroban verifier registry compares the public expiry input
with the actual invocation ledger before dispatching to a pinned verifier.

It does **not** prove AI reasoning, bridge completion, EVM state, anonymity, or
generic denylist non-membership. The source is compiled to R1CS/WASM during the
repository gate; a valid witness plus invalid cap, non-canonical 64-bit and
execution-context vectors are exercised. Generated build output is ignored.
`KletiaPolicyV2.circom` is the canonical Workflow V4 circuit. Unlike V1, its
selected protocol, asset and recipient leaves are public inputs that Kletia
recomputes from the exact selected route. Their Merkle paths remain private and
prove membership in registry roots that were signed before route selection.
The public-input order is pinned in `public-inputs.v2.json`; V1 proofs and
9-input verifier records are never accepted by Workflow V4. V2 still does not
hide public-chain transaction fields or prove a foreign-chain result.

The current Testnet-development release is pinned to:

- circuit source SHA-256 `6dbb3e6247265135e66e7614c1fbac2ace437928c07abbd8fd9fe8a402e4eb70`
- R1CS SHA-256 `fe7e0cafdda02d637c0852a94708b11fc6a7f051d6a563519a85a9640cac8495`
- prover WASM SHA-256 `f13d9dc4e1ee86fd432a45d9696c91122d8beef3906687acb6a84d1b311115a5`
- proving key SHA-256 `797054251bab3165a7cdc868d81027b306462e9e181c97db8ec4238344d2b52a`
- encoded verifier-key SHA-256 `c4b6f6eb1a6b845c587cb3481461d0a710cac76702265fc2608ff94ad61a78f8`

This is a development ceremony for Stellar Testnet, not a production trusted
setup or audit claim. Runtime readiness additionally requires the exact live
registry, immutable verifier and Intent Control Plane V2 bindings.

The `policy-groth16-verifier` package implements the immutable-key BN254
pairing equation and is tested with a real proof produced by an unsafe,
single-contributor local setup. That fixture proves encoding and verifier
interoperability only. No production proving key, production verification key
or deployed verifier is claimed. The API and registry remain fail-closed until
a reviewed setup, exact artifact hashes, deployed verifier and live registry
record all agree.
