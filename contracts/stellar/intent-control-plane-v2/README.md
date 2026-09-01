# Kletia Intent Control Plane V2

This Soroban contract binds one owner-authorized workflow to a pre-authorized
Policy V2 root, the exact selected protocol/asset/recipient leaves, a nullifier
and a terminal receipt root.

The contract constructs the twelve Policy V2 public inputs itself and delegates
proof verification to the versioned `KletiaPolicyVerifierRegistry`. It rejects
nonce reuse, global nullifier reuse, expired policies, zero commitments and
late receipt finalization. State is reserved before the external verifier call;
Soroban rolls those writes back if verification fails.

It does not hold funds, approve tokens, prove a foreign-chain receipt by itself,
make cross-chain execution atomic or make public ledgers confidential. The owner
must authorize the exact invocation, and independent adapters must verify every
external checkpoint before a receipt root may be proposed.

Status: deployed on Stellar Testnet with verifier version 2, live executable
attestation and an owner-signed real Groth16 `commit → finalize` smoke. Exact
evidence is pinned in `../deployments/testnet/control-plane.v2.json`. This is
still an unaudited Testnet-development release, not a Mainnet claim.

`../scripts/deploy-control-plane-v2-testnet.sh` is fail-closed by default. It
rebuilds all three contracts, compares every circuit/WASM/VK artifact with
`../control-plane-v2.lock.json` and exits without sending a transaction unless
the exact Testnet confirmation phrase is present. It can deploy a dedicated V2
registry or, only after checking its administrator and empty version slot, use
an explicitly supplied registry. Its output is public runtime configuration
only; a signer never belongs in the API or frontend environment.
