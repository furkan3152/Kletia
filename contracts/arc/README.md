# Kletia Contracts — Arc Testnet

Arc-only Solidity workspace for contracts deployed on Arc Testnet (`5042002`).
The application-routed surface includes native-USDC swap, vault, staking,
lending, memo, batch-payment and agent-registry contracts. KLET is the Arc
application token and `KletiaArcForwarder` is the shared ERC-2771 trust root.

Canonical addresses and live explorer verification state are recorded in
[`deployments/arc-testnet.json`](deployments/arc-testnet.json). The historical
OTC contract is retained under `contracts/legacy` for deployment provenance;
it is deliberately absent from the API and web runtime registries.

`KletiaArcVaultV2` is the active new-deposit Vault at
`0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d`. Its Solidity 0.8.24 source and
constructor arguments are exact-verified on ArcScan, and the API pins runtime
codehash `0xa6cb476a1243a6d9bc71909a5774d1340061e91bcb47cd8aea3df1f5444bec1f`
before producing a plan. Aggregate principal and interest liabilities are
enforced inside every normal withdrawal, and an emergency withdrawal can
return only the caller's principal. The immutable legacy Vault remains enabled
only for each depositor's explicit self-custodial migration withdrawal; new
deposits never route to it. The full evidence and migration state are recorded
in the manifest and [`VAULT_V2_MIGRATION.md`](VAULT_V2_MIGRATION.md).

```bash
npm ci --legacy-peer-deps
npm run compile
npm test
npm run reserves:status
# Owner-only write path; recalculates at the latest block before sending:
npm run reconcile:reserves
# Deployment reproduction only; the active V2 address is already deployed:
npm run deploy:vault-v2 -- --network arc
```

`reserves:status` is read-only and deliberately does not require a signer. The
funding command requires `ARC_PRIVATE_KEY`, proves that the derived account is
the exact Vault and Staking owner, simulates each owner-only call, and
recalculates liabilities immediately before submission. Deployment and
verification credentials are local-only. Use `ARC_PRIVATE_KEY` and
`ARCSCAN_API_KEY` only in this package's ignored `.env`; never expose them to
the web application or API runtime.

Arc production deployments were compiled with Solidity 0.8.24/0.8.20,
`evmVersion: cancun`, and optimizer disabled. Keep those settings unchanged
when reproducing explorer verification.
