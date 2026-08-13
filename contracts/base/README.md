# Kletia Contracts — Base Mainnet

Base-only Solidity workspace for Kletia routers, adapters, token launch, x402
and supporting legacy deployments.

- `contracts/v2`: current intent-router architecture and typed adapters
- `contracts/legacy`: source retained for existing Base deployments
- `contracts/x402`: Base x402 seller contracts
- `deployments`: public deployment manifests and runtime identities
- `scripts/v2`: evidence exporters and release policy tooling
- `scripts/verification`: reproducible exact-source/runtime verification tools

Legacy source is intentionally isolated and is not an alternate deployment
entrypoint. The package does not keep ambiguous one-off deployment scripts.

No Arc deployment source belongs in this package.

## Deployed X402Factory exact-source reproduction

The live factory predates the current directory layout. Its verified compiler
source keys were `contracts/X402Factory.sol` and `contracts/X402Gateway.sol`,
so a normal Hardhat artifact built from `contracts/x402/` has different source
metadata even when the Solidity text is identical. The dedicated verifier
reconstructs the original Standard JSON input with Solidity 0.8.20, Paris EVM
and optimizer 200, then requires its runtime bytecode to match Base Mainnet
byte-for-byte before an explorer submission is allowed:

```bash
npm run verify:x402-factory
BASESCAN_API_KEY=<server-or-shell-secret> npm run verify:x402-factory:submit
```

The first command is read-only and needs no credential. It requires both a
byte-for-byte live runtime match and BaseScan's `Exact Match` badge. BaseScan
currently also shows a `Similar Match` source-attribution link; that records
where its byte-identical published source was inherited from and does not
negate the Exact Match result. The second command is available only if a fresh
self-attribution submission is desired; it submits the same proven Standard
JSON through the official Etherscan V2 API and waits for a final result.

Every gateway created by the live factory can be reproduced and verified with:

```bash
npm run verify:x402-gateways:blockscout
```

The command discovers children from the factory, compiles their original
Solidity 0.8.20 Standard JSON input, fills the live immutable USDC address and
requires a byte-for-byte runtime match before submitting an unverified child
to Blockscout with the MIT license. It needs no private key and is safe to
rerun; already verified children are only checked.

## Intent Router V2 canary

The deployed Uniswap V2 adapter is intentionally unavailable to application
traffic until both delayed operations and runtime evidence are complete. The
operational sequence is:

```bash
npm run canary:v2:status
# If the operator uses a connected wallet instead of BASE_PRIVATE_KEY:
npm run canary:v2:prepare-configure-execution
npm run canary:v2:execute-configure
npm run canary:v2:prepare-enable
# Submit the emitted transaction to the Governance Safe and collect 2 signatures.
# After the on-chain minimum delay:
npm run canary:v2:prepare-enable-execution
npm run canary:v2:execute-enable
npm run evidence:v2:base:deployment
```

`execute-*` needs a gas-paying Base signer. The `prepare-*-execution` variants
emit the same exact transaction for an external connected wallet and never
read a private key. `prepare-enable` does not possess or bypass Governance Safe
authority. Keep both application release modes at `legacy_v1` until the final
evidence exporter succeeds.
