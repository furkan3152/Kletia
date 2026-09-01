# Kletia Policy Verifier Registry

This contract pins immutable verifier versions to an exact verifier contract,
verification-key hash, circuit hash and public-input schema hash. It dispatches
proof verification to that pinned contract and fails closed when a version is
missing or disabled.

Each version also pins the exact public-input count and the lane/ledger-expiry
indices. Before proof dispatch the registry rejects malformed field encodings,
unknown lane values and an expiry at or before the actual Soroban invocation
ledger. A caller-selected timestamp therefore cannot make an expired policy
appear valid.

It is deliberately not itself a generic Groth16 implementation. A release must
deploy and pin a reviewed BN254 verifier contract generated from the exact
Kletia policy circuit. Until that verifier and its artifacts are reproducible,
the V3 API reports the ZK policy capability as unavailable.
