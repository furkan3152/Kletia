# Kletia Intent Control Plane

This Soroban contract stores one owner-authorized workflow root and policy root,
consumes a global opaque nullifier, and optionally closes the lifecycle with an
opaque receipt root. Its constructor permanently binds the reviewed Policy
Verifier Registry. `commit` constructs the nine public inputs itself and
requires that registry to accept the versioned proof before the commit can
complete. Nonce, nullifier and workflow slots are reserved before the external
verifier call to close reentrancy; Soroban atomically rolls those reservations
back if verification errors or rejects. The negative-proof test asserts that
no rejected state survives. A proof for different roots, lane, expiry,
nullifier or execution context therefore cannot be reused as a commit.

It never holds funds, approves tokens, signs foreign-chain transactions, or
proves that an EVM/CCTP result is true. Policy-proof acceptance proves only the
constraints encoded by the pinned circuit and verification key.

The source is ready for review and tests. Deployment is intentionally deferred;
the API remains fail-closed until the deployed contract ID and release WASM hash
are pinned and re-attested on Stellar Testnet.
