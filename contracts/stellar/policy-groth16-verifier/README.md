# Kletia Policy Groth16 Verifier

This package is the circuit-bound verifier target used by the versioned policy
verifier registry. It uses the BN254 host functions exposed by
`soroban-sdk 27.0.6` and implements the standard Groth16 equation:

`e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1`

The verification key is supplied once in the contract constructor, validated
by the Soroban host and stored immutably. The contract computes its own
canonical verification-key hash, rejects a registry-provided hash mismatch,
requires the exact public-input count, rejects non-canonical BN254 scalar
encodings and accepts only the fixed 256-byte proof encoding
`A(64) | B(128) | C(64)`.

G1 is encoded as `x | y`, with each coordinate a 32-byte big-endian field
element. G2 follows the Soroban/Ethereum-compatible
`x.c1 | x.c0 | y.c1 | y.c0` order. Tooling that converts snarkjs JSON must
perform this G2 component reversal explicitly.

The package is source code, not a deployed verifier. A Testnet deployment must
be bound to a reviewed phase-2 setup, exact verification key, circuit source,
public-input schema, release WASM hash and registry record. The deterministic
test vector used by host tests is intentionally generated from an unsafe local
development ceremony and MUST NOT be reused for deployment or proving real
policies. It is a single-contributor local setup, not a production ceremony.

The pairing equation and wire format follow Stellar's Protocol 25 BN254 SDK
documentation. Stellar's native primitives make verification possible but do
not themselves provide an end-to-end private-payment system.
