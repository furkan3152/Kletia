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

## Active Intent Router V2 release

The active Base Mainnet release uses the existing two-of-two Governance Safe
directly; the superseded Timelock deployment remains only in the deployment
manifest's history. The reviewed Uniswap V2 adapter is configured and enabled,
and the application runs in `intent_v2` mode with fail-closed runtime evidence.
The reproducible operator sequence is:

```bash
npm run deploy:v2:direct-safe
npm run verify:v2:blockscout
npm run evidence:v2:base:deployment
```

Deployment requires the two existing Safe owner keys only for the bounded
operator run; they must stay in ignored package-local environment files and be
removed immediately afterward. The script validates both owners, threshold,
chain, role accounts, existing adapter, WETH and gas balance before its first
broadcast. It deploys the three contracts and submits one exact Safe call to
configure and enable the adapter. Verification and evidence export are
read-only. Active public identities are recorded in
`deployments/base-mainnet-v2.json`; do not copy addresses from chat logs.
